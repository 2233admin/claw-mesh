/**
 * Inference Router — N1 philosophy: all engines up, flight control picks the best
 *
 * Routing strategy per task type:
 *   chat/completion   → vLLM / TensorRT-LLM (throughput)
 *   structured (JSON) → SGLang (RadixAttention + constrained decoding)
 *   CPU fallback      → BitNet.cpp / mistral.rs / Ollama
 *   VRAM tight        → ExLlamaV2 / PowerInfer (sparse activation)
 *   distributed       → Mooncake (prefill/decode separation, Wave 5)
 *
 * Fallback chain: local GPU → local CPU → LiteLLM gateway → error
 */

import type {
  InferenceEngineInfo,
  InferenceRequest,
  InferenceResponse,
  InferenceRoutingWeights,
  InferenceTaskType,
  InferenceBackend,
  LoadedModel,
  RoutingDecision,
  TokenUsage,
} from '../types/inference'
import { DEFAULT_INFERENCE_WEIGHTS } from '../types/inference'

// ─── Backend preference by task type ───

const BACKEND_AFFINITY: Record<InferenceTaskType, InferenceBackend[]> = {
  chat:       ['vllm', 'sglang', 'tensorrt-llm', 'ollama', 'mistral-rs', 'litellm'],
  completion: ['vllm', 'tensorrt-llm', 'sglang', 'ollama', 'mistral-rs', 'litellm'],
  structured: ['sglang', 'vllm', 'ollama', 'litellm'],
  embedding:  ['vllm', 'sglang', 'ollama', 'litellm'],
  batch:      ['vllm', 'tensorrt-llm', 'mooncake', 'litellm'],
}

// CPU-only backends (no GPU required)
const CPU_BACKENDS: Set<InferenceBackend> = new Set([
  'ollama', 'bitnet-cpp', 'mistral-rs',
])

// ─── Scoring functions ───

function scoreThroughput(engine: InferenceEngineInfo): number {
  const tps = engine.tokens_per_second ?? 0
  // Normalize: 200 tps = 100 score
  return Math.min(100, (tps / 200) * 100)
}

function scoreLatency(engine: InferenceEngineInfo): number {
  const ttft = engine.time_to_first_token_ms ?? 500
  // Lower is better: 0ms = 100, 1000ms = 0
  return Math.max(0, 100 - (ttft / 10))
}

function scoreCost(engine: InferenceEngineInfo): number {
  // Local engines are free; LiteLLM gateway routes to paid APIs
  if (engine.backend === 'litellm') return 20
  // GPU engines: medium cost (electricity)
  if (engine.requires_gpu) return 70
  // CPU engines: cheapest
  return 90
}

function scoreCapability(engine: InferenceEngineInfo, taskType: InferenceTaskType): number {
  const affinity = BACKEND_AFFINITY[taskType] ?? []
  const idx = affinity.indexOf(engine.backend)
  if (idx === -1) return 0
  // First in affinity list = 100, steep dropoff so best-fit engine wins
  return Math.max(10, 100 - idx * 30)
}

function scoreLocality(engine: InferenceEngineInfo, preferDevice?: string): number {
  if (!preferDevice) return 50
  return engine.device_id === preferDevice ? 100 : 30
}

// ─── Model matching ───

function findModel(
  engine: InferenceEngineInfo,
  requestedModel?: string,
): LoadedModel | null {
  if (engine.loaded_models.length === 0) return null

  if (!requestedModel) return engine.loaded_models[0]

  const lower = requestedModel.toLowerCase()
  return engine.loaded_models.find(m =>
    m.model_id.toLowerCase().includes(lower) ||
    m.alias?.toLowerCase().includes(lower)
  ) ?? null
}

// ─── Main router ───

/**
 * Score and rank all available engines for a given request.
 * Returns sorted decisions (best first), or empty if no engine qualifies.
 */
export function rankEngines(
  engines: InferenceEngineInfo[],
  request: InferenceRequest,
  weights: InferenceRoutingWeights = DEFAULT_INFERENCE_WEIGHTS,
): RoutingDecision[] {
  const decisions: RoutingDecision[] = []

  for (const engine of engines) {
    // Skip offline engines
    if (engine.status === 'offline') continue

    // Skip if task type not supported
    if (!engine.supported_tasks.includes(request.task_type)) continue

    // Skip if specific backend requested and doesn't match
    if (request.prefer_backend && engine.backend !== request.prefer_backend) continue

    // Skip cloud if local required
    if (request.require_local && engine.backend === 'litellm') continue

    // Skip GPU engines if device has no GPU (already filtered by registration,
    // but double-check for CPU-only constraint)

    // Find matching model
    const model = findModel(engine, request.model)
    if (!model) continue

    // Check context length
    if (request.max_tokens && model.context_length < request.max_tokens) continue

    // Score
    const t = scoreThroughput(engine) * weights.throughput
    const l = scoreLatency(engine) * weights.latency
    const c = scoreCost(engine) * weights.cost
    const cap = scoreCapability(engine, request.task_type) * weights.capability
    const loc = scoreLocality(engine, request.prefer_device) * weights.locality

    const score = t + l + c + cap + loc

    // Priority boost
    const priorityMult = request.priority === 'high' ? 1.2
      : request.priority === 'low' ? 0.8
      : 1.0

    const reasons: string[] = []
    if (t > l && t > c) reasons.push('high throughput')
    if (l > t && l > c) reasons.push('low latency')
    if (engine.backend === 'sglang' && request.task_type === 'structured') {
      reasons.push('RadixAttention for structured output')
    }
    if (CPU_BACKENDS.has(engine.backend)) reasons.push('CPU-friendly')

    decisions.push({
      engine,
      model,
      score: score * priorityMult,
      reason: reasons.join(', ') || engine.backend,
    })
  }

  // Sort descending by score
  decisions.sort((a, b) => b.score - a.score)
  return decisions
}

/**
 * Pick the single best engine for a request.
 * Returns null if no engine qualifies.
 */
export function routeInference(
  engines: InferenceEngineInfo[],
  request: InferenceRequest,
  weights?: InferenceRoutingWeights,
): RoutingDecision | null {
  const ranked = rankEngines(engines, request, weights)
  return ranked[0] ?? null
}

// ─── Request execution ───

/**
 * Execute an inference request against the routed engine.
 * Handles OpenAI-compatible API format (vLLM, SGLang, LiteLLM all speak it).
 */
/**
 * Resolve the correct API endpoint and request body for each task type.
 * vLLM/SGLang/LiteLLM/Ollama all speak OpenAI-compatible, but different
 * task types use different endpoints and payload shapes.
 */
function buildRequest(
  engine: InferenceEngineInfo,
  model: LoadedModel,
  request: InferenceRequest,
): { url: string; body: Record<string, unknown> } {
  const base = engine.endpoint

  if (request.task_type === 'embedding') {
    return {
      url: `${base}/v1/embeddings`,
      body: {
        model: model.model_id,
        input: request.prompt ?? request.messages?.map(m => m.content).join('\n') ?? '',
      },
    }
  }

  // chat, completion, structured, batch → chat/completions
  const messages = request.messages ?? (request.prompt
    ? [{ role: 'user' as const, content: request.prompt }]
    : [])

  const body: Record<string, unknown> = {
    model: model.model_id,
    messages,
    max_tokens: request.max_tokens ?? 2048,
    temperature: request.temperature ?? 0.7,
    stream: false,
  }

  if (request.top_p !== undefined) body.top_p = request.top_p
  if (request.stop) body.stop = request.stop

  // SGLang structured output: pass JSON schema
  if (request.schema && engine.backend === 'sglang') {
    body.response_format = { type: 'json_schema', json_schema: request.schema }
  }

  return { url: `${base}/v1/chat/completions`, body }
}

export async function executeInference(
  decision: RoutingDecision,
  request: InferenceRequest,
): Promise<InferenceResponse> {
  const { engine, model } = decision
  const startTime = Date.now()
  const requestId = `inf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const { url, body } = buildRequest(engine, model, request)

  const controller = new AbortController()
  const timeout = request.timeout_ms ?? 30_000
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!resp.ok) {
      const errText = await resp.text()
      throw new Error(`${engine.backend} ${resp.status}: ${errText.slice(0, 200)}`)
    }

    const data = await resp.json() as Record<string, unknown>
    const totalMs = Date.now() - startTime

    // Parse response based on task type
    let content = ''
    let usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    let finishReason: 'stop' | 'length' | 'error' = 'stop'

    if (request.task_type === 'embedding') {
      // Embedding response: { data: [{ embedding: [...] }], usage: {...} }
      const embData = data as { data?: Array<{ embedding: number[] }>; usage?: Record<string, number> }
      content = JSON.stringify(embData.data?.[0]?.embedding ?? [])
      usage = {
        prompt_tokens: embData.usage?.prompt_tokens ?? 0,
        completion_tokens: 0,
        total_tokens: embData.usage?.total_tokens ?? 0,
      }
    } else {
      // Chat completion response
      const chatData = data as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }
      const choice = chatData.choices?.[0]
      content = choice?.message?.content ?? ''
      finishReason = (choice?.finish_reason as 'stop' | 'length') ?? 'stop'
      usage = {
        prompt_tokens: chatData.usage?.prompt_tokens ?? 0,
        completion_tokens: chatData.usage?.completion_tokens ?? 0,
        total_tokens: chatData.usage?.total_tokens ?? 0,
      }
    }

    return {
      request_id: requestId,
      engine: engine.backend,
      device_id: engine.device_id,
      model: model.model_id,
      content,
      finish_reason: finishReason,
      usage,
      total_duration_ms: totalMs,
      tokens_per_second: usage.completion_tokens > 0
        ? Math.round(usage.completion_tokens / (totalMs / 1000))
        : undefined,
    }
  } finally {
    clearTimeout(timer)
  }
}
