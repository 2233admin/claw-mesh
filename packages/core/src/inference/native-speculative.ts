/**
 * Native Speculative Decoding — vLLM/SGLang built-in speculation
 *
 * vLLM 0.4+ supports --speculative-model for GPU-level zero-copy
 * draft/verify. This is 10x+ faster than our HTTP-level implementation
 * in speculative-decoder.ts because:
 *   - Draft and target share GPU memory (no network transfer)
 *   - Verification happens in a single fused kernel
 *   - KV cache is shared, not regenerated
 *
 * This module configures native speculation on supported backends
 * and falls back to our TS implementation when native is unavailable.
 *
 * Priority chain:
 *   1. vLLM --speculative-model (GPU zero-copy, fastest)
 *   2. SGLang speculative decoding (if supported)
 *   3. TS speculative-decoder.ts (HTTP-level, our fallback)
 */

import type {
  InferenceEngineInfo,
  InferenceRequest,
  InferenceResponse,
  InferenceBackend,
} from '../types/inference'
import {
  speculativeDecode,
  findSpeculativePairs,
  DEFAULT_SPECULATIVE_CONFIG,
} from './speculative-decoder'
import type { SpeculativeConfig, SpeculativePair } from './speculative-decoder'

// ─── Native speculation config ───

export interface NativeSpecConfig {
  /** Draft model ID for vLLM --speculative-model */
  draft_model: string
  /** Number of speculative tokens (vLLM --num-speculative-tokens) */
  num_speculative_tokens: number
  /** Speculation method: 'draft_model' | 'ngram' | 'medusa' | 'eagle' */
  method: 'draft_model' | 'ngram' | 'medusa' | 'eagle'
  /** For ngram method: n-gram size */
  ngram_size?: number
}

export interface NativeSpecStatus {
  backend: InferenceBackend
  engine_endpoint: string
  native_supported: boolean
  method: string | null
  draft_model: string | null
  num_speculative_tokens: number | null
}

// ─── Probe native speculation support ───

/**
 * Check if a vLLM/SGLang instance has native speculative decoding enabled.
 * Queries the /v1/models endpoint and checks model config.
 */
export async function probeNativeSpeculation(
  engine: InferenceEngineInfo,
): Promise<NativeSpecStatus> {
  const status: NativeSpecStatus = {
    backend: engine.backend,
    engine_endpoint: engine.endpoint,
    native_supported: false,
    method: null,
    draft_model: null,
    num_speculative_tokens: null,
  }

  if (engine.backend !== 'vllm' && engine.backend !== 'sglang') {
    return status
  }

  try {
    // vLLM exposes speculation config via /v1/models or /health
    const resp = await fetch(`${engine.endpoint}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    })

    if (!resp.ok) return status

    const data = await resp.json() as {
      data?: Array<{
        id: string
        speculative_config?: {
          draft_model?: string
          num_speculative_tokens?: number
          method?: string
          ngram_size?: number
        }
      }>
    }

    // Check each model for speculative config
    for (const model of data.data ?? []) {
      if (model.speculative_config) {
        status.native_supported = true
        status.method = model.speculative_config.method ?? 'draft_model'
        status.draft_model = model.speculative_config.draft_model ?? null
        status.num_speculative_tokens = model.speculative_config.num_speculative_tokens ?? null
        break
      }
    }

    // Fallback: check if the model list itself suggests speculation
    // (some vLLM versions expose the draft model as a separate model entry)
    if (!status.native_supported && data.data && data.data.length >= 2) {
      // Heuristic: if there's a small and large model from same family, might be speculative
      // But don't mark as native — let the admin configure it explicitly
    }
  } catch {
    // Probe failed — not available
  }

  return status
}

// ─── Smart speculation router ───

/**
 * Execute inference with the best available speculation strategy.
 *
 * Decision tree:
 *   1. If target engine has native speculation → use it directly (just send request)
 *   2. If we can find a CPU draft + GPU target pair → use TS speculative decoder
 *   3. Otherwise → standard single-engine inference
 */
export async function speculativeInference(
  engines: InferenceEngineInfo[],
  request: InferenceRequest,
  specConfig?: SpeculativeConfig,
): Promise<{ response: InferenceResponse; strategy: 'native' | 'ts-speculative' | 'direct' }> {
  const config = specConfig ?? DEFAULT_SPECULATIVE_CONFIG

  // Strategy 1: Check for native speculation on GPU engines
  const gpuEngines = engines.filter(e =>
    (e.backend === 'vllm' || e.backend === 'sglang') &&
    e.status !== 'offline' &&
    e.requires_gpu
  )

  for (const engine of gpuEngines) {
    const nativeStatus = await probeNativeSpeculation(engine)
    if (nativeStatus.native_supported) {
      // Native speculation is active — just send the request normally.
      // vLLM handles draft/verify internally at GPU level.
      const model = engine.loaded_models.find(m =>
        !request.model || m.model_id.toLowerCase().includes(request.model.toLowerCase())
      ) ?? engine.loaded_models[0]

      if (model) {
        const response = await executeDirectInference(engine, model.model_id, request)
        return { response, strategy: 'native' }
      }
    }
  }

  // Strategy 2: TS-level speculative decoding (CPU draft → GPU verify)
  if (request.task_type === 'chat' || request.task_type === 'completion') {
    const pairs = findSpeculativePairs(engines)
    if (pairs.length > 0) {
      const bestPair = pairs[0] // Already sorted by sameFamily match
      const response = await speculativeDecode(bestPair, request, config)
      return { response, strategy: 'ts-speculative' }
    }
  }

  // Strategy 3: Direct inference (no speculation)
  const bestEngine = engines
    .filter(e => e.status !== 'offline' && e.loaded_models.length > 0)
    .sort((a, b) => (b.tokens_per_second ?? 0) - (a.tokens_per_second ?? 0))[0]

  if (!bestEngine) {
    return {
      response: errorResponse('No engines available'),
      strategy: 'direct',
    }
  }

  const model = bestEngine.loaded_models[0]
  const response = await executeDirectInference(bestEngine, model.model_id, request)
  return { response, strategy: 'direct' }
}

// ─── vLLM launch config generator ───

/**
 * Generate vLLM launch arguments for native speculative decoding.
 * Use in deploy/super/setup-inference.sh or systemd service files.
 */
export function vllmSpeculativeArgs(config: NativeSpecConfig): string[] {
  const args: string[] = []

  if (config.method === 'draft_model') {
    args.push('--speculative-model', config.draft_model)
    args.push('--num-speculative-tokens', String(config.num_speculative_tokens))
    args.push('--speculative-disable-mqa-scorer') // use full attention for accuracy
  } else if (config.method === 'ngram') {
    args.push('--speculative-model', '[ngram]')
    args.push('--num-speculative-tokens', String(config.num_speculative_tokens))
    args.push('--ngram-prompt-lookup-max', String(config.ngram_size ?? 4))
  } else if (config.method === 'medusa' || config.method === 'eagle') {
    args.push('--speculative-model', config.draft_model)
    args.push('--num-speculative-tokens', String(config.num_speculative_tokens))
    args.push('--spec-decoding-acceptance-method', 'typical_acceptance_sampler')
  }

  return args
}

/**
 * Generate recommended vLLM config for SUPER node (RTX 5090).
 */
export function superNodeSpecConfig(): NativeSpecConfig {
  return {
    draft_model: 'Qwen/Qwen2.5-0.5B-Instruct', // tiny draft on same GPU
    num_speculative_tokens: 5,
    method: 'draft_model',
  }
}

// ─── Helpers ───

async function executeDirectInference(
  engine: InferenceEngineInfo,
  model: string,
  request: InferenceRequest,
): Promise<InferenceResponse> {
  const startTime = Date.now()
  const requestId = `spec-native-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const messages = request.messages ?? (request.prompt
    ? [{ role: 'user' as const, content: request.prompt }]
    : [])

  const resp = await fetch(`${engine.endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: request.max_tokens ?? 2048,
      temperature: request.temperature ?? 0.7,
      top_p: request.top_p,
      stop: request.stop,
      stream: false,
    }),
    signal: AbortSignal.timeout(request.timeout_ms ?? 60_000),
  })

  const totalMs = Date.now() - startTime

  if (!resp.ok) {
    return errorResponse(`${engine.backend} ${resp.status}`, requestId, engine, model, totalMs)
  }

  const data = await resp.json() as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }

  const choice = data.choices?.[0]

  return {
    request_id: requestId,
    engine: engine.backend,
    device_id: engine.device_id,
    model,
    content: choice?.message?.content ?? '',
    finish_reason: (choice?.finish_reason as 'stop' | 'length') ?? 'stop',
    usage: {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
      total_tokens: data.usage?.total_tokens ?? 0,
    },
    total_duration_ms: totalMs,
    tokens_per_second: (data.usage?.completion_tokens ?? 0) > 0
      ? Math.round((data.usage?.completion_tokens ?? 0) / (totalMs / 1000))
      : undefined,
  }
}

function errorResponse(
  msg: string,
  requestId?: string,
  engine?: InferenceEngineInfo,
  model?: string,
  totalMs?: number,
): InferenceResponse {
  return {
    request_id: requestId ?? `err-${Date.now()}`,
    engine: engine?.backend ?? 'vllm',
    device_id: engine?.device_id ?? 'none',
    model: model ?? 'none',
    content: '',
    finish_reason: 'error',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    total_duration_ms: totalMs ?? 0,
  }
}
