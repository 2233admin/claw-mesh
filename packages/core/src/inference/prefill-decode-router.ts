/**
 * Prefill/Decode Separation Router (Mooncake-inspired)
 *
 * FAST 2025 Best Paper engineering implementation:
 *   Phase 1 (Prefill): Process all input tokens → produce KV cache
 *     - Compute-bound, benefits from parallelism
 *     - Runs on CPU nodes (big memory, cheap) or GPU when available
 *   Phase 2 (Decode): Generate output tokens autoregressively
 *     - Memory-bandwidth-bound, needs fast memory
 *     - Runs on GPU (SUPER RTX 5090)
 *
 * Architecture:
 *   Client → PrefillDecodeRouter
 *     → picks prefill node (CPU cluster or GPU)
 *     → sends prompt for prefill, gets KV cache handle
 *     → picks decode node (GPU)
 *     → sends KV handle + generation params for decode
 *     → streams/returns completed response
 *
 * In our cluster:
 *   Prefill pool: 中央/硅谷/东京 (2G RAM each, Ollama/BitNet)
 *   Decode pool: SUPER (RTX 5090, vLLM/SGLang)
 *
 * Note: True KV cache transfer requires engine-level support.
 * This implementation uses a practical approximation:
 *   - Prefill node processes the prompt and returns a summary/embedding
 *   - Decode node generates from the processed context
 * When vLLM/Mooncake native disaggregation is available, swap to real KV transfer.
 */

import type {
  InferenceEngineInfo,
  InferenceRequest,
  InferenceResponse,
  InferenceBackend,
  ChatMessage,
  TokenUsage,
} from '../types/inference'

// ─── Configuration ───

export interface PrefillDecodeConfig {
  /** Minimum prompt tokens to justify separation (short prompts aren't worth the overhead). */
  min_prompt_tokens: number          // default 256
  /** Maximum time to wait for prefill phase. */
  prefill_timeout_ms: number         // default 30_000
  /** Maximum time to wait for decode phase. */
  decode_timeout_ms: number          // default 60_000
  /** Whether to try disaggregated path or fall back to single-node. */
  enabled: boolean                   // default true
}

export const DEFAULT_PD_CONFIG: PrefillDecodeConfig = {
  min_prompt_tokens: 256,
  prefill_timeout_ms: 30_000,
  decode_timeout_ms: 60_000,
  enabled: true,
}

// ─── Node pools ───

export interface PrefillDecodePool {
  /** CPU/cheap nodes for prefill (sorted by available memory descending). */
  prefill_nodes: InferenceEngineInfo[]
  /** GPU nodes for decode (sorted by tokens_per_second descending). */
  decode_nodes: InferenceEngineInfo[]
}

/** Backends suitable for prefill (big context, CPU-friendly). */
const PREFILL_BACKENDS: Set<InferenceBackend> = new Set([
  'ollama', 'bitnet-cpp', 'mistral-rs', 'vllm', 'sglang',
])

/** Backends suitable for decode (fast token generation, GPU). */
const DECODE_BACKENDS: Set<InferenceBackend> = new Set([
  'vllm', 'sglang', 'tensorrt-llm',
])

// ─── Pool discovery ───

/**
 * Classify available engines into prefill/decode pools.
 * GPU engines appear in both pools (they can do either).
 * CPU engines only appear in prefill pool.
 */
export function buildPrefillDecodePool(engines: InferenceEngineInfo[]): PrefillDecodePool {
  const online = engines.filter(e => e.status !== 'offline')

  const prefill_nodes = online
    .filter(e => PREFILL_BACKENDS.has(e.backend))
    .sort((a, b) => (b.max_context_length ?? 0) - (a.max_context_length ?? 0))

  const decode_nodes = online
    .filter(e => DECODE_BACKENDS.has(e.backend) && e.requires_gpu)
    .sort((a, b) => (b.tokens_per_second ?? 0) - (a.tokens_per_second ?? 0))

  return { prefill_nodes, decode_nodes }
}

// ─── Rough token estimation ───

function estimateTokens(messages: ChatMessage[]): number {
  const text = messages.map(m => m.content).join(' ')
  // ~4 chars per token (English approximation, conservative for CJK)
  return Math.ceil(text.length / 4)
}

// ─── Core disaggregated inference ───

/**
 * Run disaggregated prefill/decode inference.
 *
 * Falls back to single-node decode if:
 *   - Prompt is too short (overhead not worth it)
 *   - No prefill nodes available
 *   - Prefill phase fails
 */
export async function prefillDecodeInference(
  pool: PrefillDecodePool,
  request: InferenceRequest,
  config: PrefillDecodeConfig = DEFAULT_PD_CONFIG,
): Promise<InferenceResponse> {
  const startTime = Date.now()
  const requestId = `pd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const messages = request.messages ?? (request.prompt
    ? [{ role: 'user' as const, content: request.prompt }]
    : [])

  const estimatedPromptTokens = estimateTokens(messages)

  // Decision: should we disaggregate?
  const shouldDisaggregate =
    config.enabled &&
    pool.prefill_nodes.length > 0 &&
    pool.decode_nodes.length > 0 &&
    estimatedPromptTokens >= config.min_prompt_tokens

  if (!shouldDisaggregate) {
    // Fall back to single best decode node
    return singleNodeInference(
      pool.decode_nodes[0] ?? pool.prefill_nodes[0],
      request, requestId, startTime,
    )
  }

  // Phase 1: Prefill on CPU node
  // Send the full prompt for processing; get back a condensed representation.
  // In a true Mooncake implementation, this would return a KV cache pointer.
  // Here we use the prefill node to generate a "processed context" message.
  const prefillNode = pool.prefill_nodes[0]
  const prefillModel = prefillNode.loaded_models[0]
  if (!prefillModel) {
    return singleNodeInference(pool.decode_nodes[0], request, requestId, startTime)
  }

  let prefillResult: { content: string; prefill_ms: number; prompt_tokens: number }

  try {
    prefillResult = await runPrefill(prefillNode, prefillModel.model_id, messages, config)
  } catch {
    // Prefill failed — fall back to single-node
    return singleNodeInference(pool.decode_nodes[0], request, requestId, startTime)
  }

  // Phase 2: Decode on GPU node
  // Pass the prefill context + original system messages to the decode node
  const decodeNode = pool.decode_nodes[0]
  const decodeModel = decodeNode.loaded_models[0]
  if (!decodeModel) {
    return singleNodeInference(prefillNode, request, requestId, startTime)
  }

  const decodeMessages: ChatMessage[] = [
    // Keep system messages from original request
    ...messages.filter(m => m.role === 'system'),
    // Inject prefill context as a condensed user message
    { role: 'user', content: prefillResult.content },
  ]

  const decodeResp = await runDecode(
    decodeNode, decodeModel.model_id, decodeMessages, request, config,
  )

  const totalMs = Date.now() - startTime

  const usage: TokenUsage = {
    prompt_tokens: prefillResult.prompt_tokens + (decodeResp.prompt_tokens ?? 0),
    completion_tokens: decodeResp.completion_tokens,
    total_tokens: prefillResult.prompt_tokens + (decodeResp.prompt_tokens ?? 0) + decodeResp.completion_tokens,
  }

  return {
    request_id: requestId,
    engine: decodeNode.backend,
    device_id: decodeNode.device_id,
    model: decodeModel.model_id,
    content: decodeResp.content,
    finish_reason: decodeResp.finish_reason,
    usage,
    total_duration_ms: totalMs,
    tokens_per_second: decodeResp.completion_tokens > 0
      ? Math.round(decodeResp.completion_tokens / (totalMs / 1000))
      : undefined,
  }
}

// ─── Phase helpers ───

async function runPrefill(
  engine: InferenceEngineInfo,
  model: string,
  messages: ChatMessage[],
  config: PrefillDecodeConfig,
): Promise<{ content: string; prefill_ms: number; prompt_tokens: number }> {
  const start = Date.now()

  // Ask the prefill node to process and summarize the context.
  // The prefill node returns a processed version of the input that
  // captures the essential context for the decode node.
  const prefillMessages: ChatMessage[] = [
    {
      role: 'system',
      content: 'Process the following conversation and produce a concise context summary that preserves all key information, instructions, and constraints. Output only the summary.',
    },
    ...messages,
  ]

  const resp = await fetch(`${engine.endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: prefillMessages,
      max_tokens: 1024,
      temperature: 0.3, // low temp for faithful summarization
      stream: false,
    }),
    signal: AbortSignal.timeout(config.prefill_timeout_ms),
  })

  if (!resp.ok) {
    throw new Error(`Prefill failed: ${resp.status}`)
  }

  const data = await resp.json() as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }

  return {
    content: data.choices?.[0]?.message?.content ?? '',
    prefill_ms: Date.now() - start,
    prompt_tokens: data.usage?.prompt_tokens ?? 0,
  }
}

async function runDecode(
  engine: InferenceEngineInfo,
  model: string,
  messages: ChatMessage[],
  request: InferenceRequest,
  config: PrefillDecodeConfig,
): Promise<{
  content: string
  finish_reason: 'stop' | 'length' | 'error'
  completion_tokens: number
  prompt_tokens: number
}> {
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
    signal: AbortSignal.timeout(config.decode_timeout_ms),
  })

  if (!resp.ok) {
    return { content: '', finish_reason: 'error', completion_tokens: 0, prompt_tokens: 0 }
  }

  const data = await resp.json() as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }

  const choice = data.choices?.[0]

  return {
    content: choice?.message?.content ?? '',
    finish_reason: (choice?.finish_reason as 'stop' | 'length') ?? 'stop',
    completion_tokens: data.usage?.completion_tokens ?? 0,
    prompt_tokens: data.usage?.prompt_tokens ?? 0,
  }
}

// ─── Single-node fallback ───

async function singleNodeInference(
  engine: InferenceEngineInfo | undefined,
  request: InferenceRequest,
  requestId: string,
  startTime: number,
): Promise<InferenceResponse> {
  if (!engine || engine.loaded_models.length === 0) {
    return {
      request_id: requestId,
      engine: 'ollama',
      device_id: 'none',
      model: 'none',
      content: '',
      finish_reason: 'error',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      total_duration_ms: Date.now() - startTime,
    }
  }

  const model = engine.loaded_models[0]
  const messages = request.messages ?? (request.prompt
    ? [{ role: 'user' as const, content: request.prompt }]
    : [])

  const resp = await fetch(`${engine.endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.model_id,
      messages,
      max_tokens: request.max_tokens ?? 2048,
      temperature: request.temperature ?? 0.7,
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  })

  const totalMs = Date.now() - startTime

  if (!resp.ok) {
    return {
      request_id: requestId,
      engine: engine.backend,
      device_id: engine.device_id,
      model: model.model_id,
      content: '',
      finish_reason: 'error',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      total_duration_ms: totalMs,
    }
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
    model: model.model_id,
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
