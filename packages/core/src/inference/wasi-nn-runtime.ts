/**
 * WASI-NN Inference Runtime
 *
 * Extends WasmRunner with neural network inference capability:
 *   - Loads GGML/GGUF models inside WASM sandbox via WASI-NN
 *   - Same 8MB sandbox is both execution environment and inference engine
 *   - Compatible with Ollama model format (GGUF)
 *
 * Backend support:
 *   - WasmEdge with WASI-NN plugin (ggml backend)
 *   - Spin with componentize-py/js inference bindings (future)
 *
 * Usage:
 *   const nn = new WasiNNRuntime()
 *   await nn.loadModel('/path/to/model.gguf', 'ggml')
 *   const result = await nn.infer({ prompt: 'Hello', max_tokens: 100 })
 *
 * In the claw-mesh architecture, this enables CPU worker nodes to run
 * small models (1-7B) inside WASM sandboxes — isolation + inference
 * in a single lightweight runtime.
 */

import type {
  InferenceRequest,
  InferenceResponse,
  InferenceBackend,
  TokenUsage,
} from '../types/inference'
import { existsSync, realpathSync } from 'fs'
import { resolve, normalize } from 'path'

const ALLOWED_BIN_RE = /^[a-zA-Z0-9_/.\-\\:]+$/
const ALLOWED_MODEL_DIRS = ['/opt/claw-mesh/models', '/var/lib/claw-mesh/models']

function validateBinPath(bin: string): void {
  if (!ALLOWED_BIN_RE.test(bin)) throw new Error(`Invalid binary path: ${bin}`)
}

function validateModelPath(modelPath: string): void {
  const resolved = resolve(normalize(modelPath))
  if (!ALLOWED_MODEL_DIRS.some(dir => resolved.startsWith(dir)) && !process.env.CLAW_MESH_DEV) {
    throw new Error(`Model path must be under allowed directory: ${resolved}`)
  }
}

// ─── Configuration ───

export type WasiNNBackendType = 'ggml' | 'openvino' | 'pytorch' | 'tensorflowlite'

export interface WasiNNConfig {
  /** Path to wasmedge binary with WASI-NN plugin. */
  wasmedge_bin: string
  /** Default inference backend. */
  default_backend: WasiNNBackendType
  /** GPU layers to offload (0 = pure CPU). */
  n_gpu_layers: number
  /** Context size in tokens. */
  context_size: number
  /** Number of threads for CPU inference. */
  threads: number
  /** Timeout per inference call. */
  timeout_ms: number
}

export const DEFAULT_WASI_NN_CONFIG: WasiNNConfig = {
  wasmedge_bin: 'wasmedge',
  default_backend: 'ggml',
  n_gpu_layers: 0,
  context_size: 2048,
  threads: 2,    // conservative for 2-core nodes
  timeout_ms: 60_000,
}

// ─── Model registry ───

interface LoadedWasiModel {
  path: string
  backend: WasiNNBackendType
  alias: string
  loaded_at: number
}

// ─── WASI-NN inference wrapper ───

/**
 * WasiNNRuntime wraps WasmEdge's WASI-NN plugin for in-sandbox inference.
 *
 * The approach: WasmEdge ships a WASI-NN plugin that exposes `load`,
 * `init_execution_context`, `set_input`, `compute`, `get_output`
 * host functions. A small WASM "inference harness" binary calls these
 * functions. We invoke the harness with model path + prompt via CLI.
 *
 * For claw-mesh, we provide a pre-compiled inference harness WASM
 * module that:
 *   1. Loads the GGUF model via WASI-NN
 *   2. Reads prompt from stdin or CLI args
 *   3. Runs inference
 *   4. Outputs JSON: { content, tokens, duration_ms }
 */
export class WasiNNRuntime {
  private config: WasiNNConfig
  private models: Map<string, LoadedWasiModel> = new Map()
  private available: boolean | null = null

  constructor(config: Partial<WasiNNConfig> = {}) {
    this.config = { ...DEFAULT_WASI_NN_CONFIG, ...config }
  }

  /** Check if WasmEdge with WASI-NN plugin is available. */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available

    try {
      const proc = Bun.spawn(
        [this.config.wasmedge_bin, '--version'],
        { stdout: 'pipe', stderr: 'ignore' },
      )
      const output = await new Response(proc.stdout).text()
      await proc.exited

      // Check for WASI-NN plugin availability
      if (proc.exitCode !== 0) {
        this.available = false
        return false
      }

      // Try to detect WASI-NN plugin
      const pluginProc = Bun.spawn(
        [this.config.wasmedge_bin, '--help'],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const helpText = await new Response(pluginProc.stdout).text()
      await pluginProc.exited

      // WasmEdge with WASI-NN shows nn-preload in help
      this.available = helpText.includes('nn-preload') || helpText.includes('wasi-nn')
      return this.available
    } catch {
      this.available = false
      return false
    }
  }

  /** Register a GGUF model for inference. */
  loadModel(modelPath: string, backend?: WasiNNBackendType, alias?: string): boolean {
    validateModelPath(modelPath)
    if (!existsSync(modelPath)) return false

    const name = alias ?? modelPath.split(/[/\\]/).pop()?.replace(/\.gguf$/, '') ?? 'model'

    this.models.set(name, {
      path: modelPath,
      backend: backend ?? this.config.default_backend,
      alias: name,
      loaded_at: Date.now(),
    })

    return true
  }

  /** Unload a model. */
  unloadModel(alias: string): boolean {
    return this.models.delete(alias)
  }

  /** List loaded models. */
  listModels(): LoadedWasiModel[] {
    return Array.from(this.models.values())
  }

  /**
   * Run inference on a loaded model.
   *
   * Uses WasmEdge CLI with --nn-preload to load the model and
   * an inference harness WASM module to drive generation.
   */
  async infer(
    request: InferenceRequest,
    modelAlias?: string,
  ): Promise<InferenceResponse> {
    const startTime = Date.now()
    const requestId = `wasi-nn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Find model
    const model = modelAlias
      ? this.models.get(modelAlias)
      : this.models.values().next().value

    if (!model) {
      return errorResponse(requestId, startTime, 'No model loaded')
    }

    const prompt = request.prompt
      ?? request.messages?.map(m => {
        if (m.role === 'system') return `<|system|>\n${m.content}`
        if (m.role === 'user') return `<|user|>\n${m.content}`
        return `<|assistant|>\n${m.content}`
      }).join('\n') + '\n<|assistant|>\n'
      ?? ''

    const maxTokens = request.max_tokens ?? 256
    const temperature = request.temperature ?? 0.7

    // Build WasmEdge command with WASI-NN
    // wasmedge --dir .:. \
    //   --nn-preload default:GGML:AUTO:/path/to/model.gguf \
    //   inference-harness.wasm \
    //   --prompt "..." --max-tokens N --temp T
    //
    // If no harness WASM is available, fall back to wasmedge-ggml CLI mode
    const args = buildWasiNNArgs(
      this.config, model, prompt, maxTokens, temperature, request.stop,
    )

    try {
      const proc = Bun.spawn(args, {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: this.config.timeout_ms,
      })

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited

      const totalMs = Date.now() - startTime

      if (proc.exitCode !== 0) {
        // Don't leak internal paths/details in error response
        return errorResponse(requestId, startTime, 'Inference process failed')
      }

      // Parse output — expect either raw text or JSON
      const parsed = parseInferenceOutput(stdout)

      const usage: TokenUsage = {
        prompt_tokens: parsed.prompt_tokens ?? Math.ceil(prompt.length / 4),
        completion_tokens: parsed.completion_tokens ?? Math.ceil(parsed.content.length / 4),
        total_tokens: 0,
      }
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens

      return {
        request_id: requestId,
        engine: 'bitnet-cpp' as InferenceBackend, // closest match for WASI-NN
        device_id: process.env.DEVICE_ID ?? 'local',
        model: model.alias,
        content: parsed.content,
        finish_reason: parsed.finish_reason ?? 'stop',
        usage,
        total_duration_ms: totalMs,
        tokens_per_second: usage.completion_tokens > 0
          ? Math.round(usage.completion_tokens / (totalMs / 1000))
          : undefined,
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error'
      return errorResponse(requestId, startTime, msg)
    }
  }
}

// ─── Helpers ───

function buildWasiNNArgs(
  config: WasiNNConfig,
  model: LoadedWasiModel,
  prompt: string,
  maxTokens: number,
  temperature: number,
  stop?: string[],
): string[] {
  validateBinPath(config.wasmedge_bin)
  const args = [
    config.wasmedge_bin,
    '--dir', '.:.',
    '--nn-preload', `default:GGML:AUTO:${model.path}`,
  ]

  // Use the built-in llama-chat or llama-simple WASM if available
  // These are standard WasmEdge WASI-NN examples compiled to WASM
  const harnessPath = process.env.WASI_NN_HARNESS
    ?? '/opt/claw-mesh/wasm/llama-chat.wasm'

  if (existsSync(harnessPath)) {
    const resolved = resolve(normalize(harnessPath))
    if (!resolved.startsWith('/opt/claw-mesh/') && !process.env.CLAW_MESH_DEV) {
      throw new Error(`Harness must be under /opt/claw-mesh/: ${resolved}`)
    }
    args.push(resolved)
  }

  // Pass inference parameters as env-style args
  args.push(
    '--prompt', prompt,
    '--ctx-size', String(config.context_size),
    '--n-predict', String(maxTokens),
    '--temp', String(temperature),
    '--threads', String(config.threads),
    '--n-gpu-layers', String(config.n_gpu_layers),
  )

  if (stop && stop.length > 0) {
    args.push('--reverse-prompt', stop[0])
  }

  return args
}

function parseInferenceOutput(raw: string): {
  content: string
  prompt_tokens?: number
  completion_tokens?: number
  finish_reason?: 'stop' | 'length'
} {
  // Try JSON parse first
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed)
      return {
        content: obj.content ?? obj.text ?? obj.output ?? '',
        prompt_tokens: obj.prompt_tokens,
        completion_tokens: obj.completion_tokens ?? obj.tokens,
        finish_reason: obj.finish_reason,
      }
    } catch {
      // Not valid JSON, treat as raw text
    }
  }

  // Raw text output — the entire stdout is the generated text
  return { content: trimmed }
}

function errorResponse(
  requestId: string,
  startTime: number,
  error: string,
): InferenceResponse {
  return {
    request_id: requestId,
    engine: 'bitnet-cpp' as InferenceBackend,
    device_id: process.env.DEVICE_ID ?? 'local',
    model: 'none',
    content: '',
    finish_reason: 'error',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    total_duration_ms: Date.now() - startTime,
  }
}
