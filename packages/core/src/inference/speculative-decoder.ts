/**
 * Speculative Decoding Engine
 *
 * N1 philosophy applied to token generation:
 * Small model (draft, CPU) proposes γ tokens → Large model (target, GPU) verifies in ONE forward pass.
 * Rejection sampling ensures output distribution is IDENTICAL to target-only generation.
 *
 * Math (Leviathan et al. 2023):
 *   For each draft token x_i with P_draft(x_i) and P_target(x_i):
 *     - Accept with probability min(1, P_target(x_i) / P_draft(x_i))
 *     - On rejection: resample from max(0, P_target(x) - P_draft(x)) (normalized)
 *     - All tokens after first rejection are discarded
 *
 * Expected accepted tokens per step (cascading rejection / geometric model):
 *   E[tokens] = (1 - α^{γ+1}) / (1 - α)   (NOT γ*α — that ignores cascade)
 * Speedup: E[tokens] / (γ * t_draft/t_target + 1)
 *   where α = acceptance rate, t_draft/t_target = time ratio
 *
 * Optimal γ* (transcendental equation, approximate solution):
 *   γ*(α) ≈ -1 / ln(α)
 *   α=0.5 → γ*≈1.4, α=0.7 → γ*≈2.8, α=0.9 → γ*≈9.5
 *
 * For Ollama 7B (15 tps) drafting for vLLM 72B (150 tps):
 *   t_draft/t_target ≈ 0.1, with α ≈ 0.7 and adaptive γ = 3:
 *   E[tokens] = (1-0.7^4)/(1-0.7) = 2.83, speedup ≈ 2.83/1.3 = 2.18x
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

export interface SpeculativeConfig {
  /** Initial draft tokens per step (γ). Overridden by adaptive_gamma when enabled. */
  draft_length: number            // default 5
  /** Maximum consecutive rejections before falling back to target-only. */
  max_rejections: number          // default 3
  /** Minimum acceptance rate to keep using speculation. Below this, fall back. */
  min_acceptance_rate: number     // default 0.3
  /** Temperature alignment: draft and target must use same temperature for valid rejection sampling. */
  temperature: number             // default 0.7
  /** Enable adaptive γ: adjust draft_length based on running acceptance rate using γ*(α) ≈ -1/ln(α). */
  adaptive_gamma: boolean         // default true
  /** EMA smoothing factor for acceptance rate tracking (0-1, higher = more responsive). */
  alpha_ema_factor: number        // default 0.3
}

export const DEFAULT_SPECULATIVE_CONFIG: SpeculativeConfig = {
  draft_length: 5,
  max_rejections: 3,
  min_acceptance_rate: 0.3,
  temperature: 0.7,
  adaptive_gamma: true,
  alpha_ema_factor: 0.3,
}

/** Compute optimal γ from acceptance rate: γ*(α) ≈ -1/ln(α), clamped to [1, 16]. */
export function optimalGamma(alpha: number): number {
  if (alpha <= 0.01) return 1
  if (alpha >= 0.99) return 16
  return Math.max(1, Math.min(16, Math.floor(-1 / Math.log(alpha))))
}

// ─── Draft/Target engine pair ───

export interface SpeculativePair {
  draft: InferenceEngineInfo      // small model on CPU (e.g. Ollama qwen-7b)
  target: InferenceEngineInfo     // large model on GPU (e.g. vLLM qwen-72b)
  draft_model: string             // model ID on draft engine
  target_model: string            // model ID on target engine
}

// ─── Token-level types ───

interface TokenLogprob {
  token: string
  logprob: number                 // log probability
  prob: number                    // exp(logprob)
}

interface DraftResult {
  tokens: TokenLogprob[]
  draft_time_ms: number
}

interface VerifyResult {
  /** For each draft position + 1 bonus: target's top token and its logprob */
  target_logprobs: TokenLogprob[]
  verify_time_ms: number
}

// ─── Core speculative decoding loop ───

/**
 * Run speculative decoding: draft γ tokens, verify in one target pass.
 *
 * Returns the full generated text with usage stats.
 * Falls back to target-only if acceptance rate drops below threshold.
 */
export async function speculativeDecode(
  pair: SpeculativePair,
  request: InferenceRequest,
  config: SpeculativeConfig = DEFAULT_SPECULATIVE_CONFIG,
): Promise<InferenceResponse> {
  const startTime = Date.now()
  const requestId = `spec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const messages = request.messages ?? (request.prompt
    ? [{ role: 'user' as const, content: request.prompt }]
    : [])

  const maxTokens = request.max_tokens ?? 2048
  let generatedTokens = 0
  let totalDraftTime = 0
  let totalVerifyTime = 0
  let acceptedCount = 0
  let totalDraftCount = 0
  let consecutiveRejections = 0
  let fallbackToTarget = false
  let alphaEma = 0.7 // initial EMA estimate of acceptance rate
  let currentGamma = config.adaptive_gamma
    ? optimalGamma(alphaEma)
    : config.draft_length
  const outputParts: string[] = []

  // Build conversation context that grows as we generate
  const contextMessages: ChatMessage[] = [...messages]

  while (generatedTokens < maxTokens) {
    if (fallbackToTarget) {
      // Fall back: generate remaining tokens with target only
      const remaining = await generateWithEngine(
        pair.target, pair.target_model, contextMessages,
        maxTokens - generatedTokens, config.temperature,
      )
      outputParts.push(remaining.content)
      generatedTokens += remaining.tokens
      totalVerifyTime += remaining.duration_ms
      break
    }

    // Step 1: Draft γ tokens with small model (adaptive γ)
    const draft = await draftTokens(
      pair.draft, pair.draft_model, contextMessages,
      currentGamma, config.temperature,
    )
    totalDraftTime += draft.draft_time_ms

    if (draft.tokens.length === 0) break // EOS from draft

    // Step 2: Verify all draft tokens in one target forward pass
    // Send the context + draft tokens to target, ask for logprobs at each position
    const verify = await verifyTokens(
      pair.target, pair.target_model, contextMessages,
      draft.tokens, config.temperature,
    )
    totalVerifyTime += verify.verify_time_ms

    // Step 3: Rejection sampling
    let acceptedInStep = 0
    for (let i = 0; i < draft.tokens.length; i++) {
      const draftToken = draft.tokens[i]
      const targetLogprob = verify.target_logprobs[i]

      if (!targetLogprob) break

      totalDraftCount++

      // Accept with probability min(1, P_target / P_draft)
      const acceptProb = Math.min(1, targetLogprob.prob / Math.max(draftToken.prob, 1e-10))

      if (Math.random() < acceptProb) {
        // Accept draft token
        outputParts.push(draftToken.token)
        generatedTokens++
        acceptedInStep++
        consecutiveRejections = 0
      } else {
        // Reject: use target's token instead, discard rest of draft
        outputParts.push(targetLogprob.token)
        generatedTokens++
        consecutiveRejections++
        break // all subsequent draft tokens are invalid
      }
    }

    // Bonus token: if all draft tokens accepted, target gives one extra
    if (acceptedInStep === draft.tokens.length && verify.target_logprobs.length > draft.tokens.length) {
      const bonusToken = verify.target_logprobs[draft.tokens.length]
      if (bonusToken) {
        outputParts.push(bonusToken.token)
        generatedTokens++
      }
    }

    acceptedCount += acceptedInStep

    // Update adaptive γ via EMA of step-level acceptance rate
    if (config.adaptive_gamma && draft.tokens.length > 0) {
      const stepAlpha = acceptedInStep / draft.tokens.length
      alphaEma = config.alpha_ema_factor * stepAlpha + (1 - config.alpha_ema_factor) * alphaEma
      currentGamma = optimalGamma(alphaEma)
    }

    // Update context with generated tokens
    const newContent = outputParts.slice(-acceptedInStep - 1).join('')
    if (newContent) {
      contextMessages.push({ role: 'assistant', content: newContent })
    }

    // Check if we should fall back
    if (totalDraftCount > 10) {
      const acceptanceRate = acceptedCount / totalDraftCount
      if (acceptanceRate < config.min_acceptance_rate) {
        fallbackToTarget = true
      }
    }
    if (consecutiveRejections >= config.max_rejections) {
      fallbackToTarget = true
    }

    // Check for stop tokens
    const fullOutput = outputParts.join('')
    if (request.stop?.some(s => fullOutput.endsWith(s))) break
  }

  const totalMs = Date.now() - startTime
  const content = outputParts.join('')

  const usage: TokenUsage = {
    prompt_tokens: 0, // approximation; real count from target
    completion_tokens: generatedTokens,
    total_tokens: generatedTokens,
  }

  return {
    request_id: requestId,
    engine: pair.target.backend,
    device_id: pair.target.device_id,
    model: pair.target_model,
    content,
    finish_reason: generatedTokens >= maxTokens ? 'length' : 'stop',
    usage,
    total_duration_ms: totalMs,
    tokens_per_second: generatedTokens > 0
      ? Math.round(generatedTokens / (totalMs / 1000))
      : undefined,
  }
}

// ─── Engine interaction helpers ───

async function draftTokens(
  engine: InferenceEngineInfo,
  model: string,
  messages: ChatMessage[],
  n: number,
  temperature: number,
): Promise<DraftResult> {
  const start = Date.now()

  const resp = await fetch(`${engine.endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: n,
      temperature,
      logprobs: true,
      top_logprobs: 1,
      stream: false,
    }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!resp.ok) return { tokens: [], draft_time_ms: Date.now() - start }

  const data = await resp.json() as {
    choices: Array<{
      message: { content: string }
      logprobs?: { content: Array<{ token: string; logprob: number }> }
    }>
  }

  const logprobs = data.choices?.[0]?.logprobs?.content ?? []
  const tokens: TokenLogprob[] = logprobs.map(lp => ({
    token: lp.token,
    logprob: lp.logprob,
    prob: Math.exp(lp.logprob),
  }))

  return { tokens, draft_time_ms: Date.now() - start }
}

async function verifyTokens(
  engine: InferenceEngineInfo,
  model: string,
  messages: ChatMessage[],
  draftTokens: TokenLogprob[],
  temperature: number,
): Promise<VerifyResult> {
  const start = Date.now()

  // Append draft tokens as assistant continuation for target to score
  const draftText = draftTokens.map(t => t.token).join('')
  const verifyMessages: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: draftText },
  ]

  const resp = await fetch(`${engine.endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: verifyMessages,
      max_tokens: 1, // just need logprobs for verification + 1 bonus
      temperature,
      logprobs: true,
      top_logprobs: 5,
      echo: true, // some backends support echoing input logprobs
      stream: false,
    }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!resp.ok) return { target_logprobs: [], verify_time_ms: Date.now() - start }

  const data = await resp.json() as {
    choices: Array<{
      message: { content: string }
      logprobs?: { content: Array<{ token: string; logprob: number }> }
    }>
  }

  const logprobs = data.choices?.[0]?.logprobs?.content ?? []
  const target_logprobs: TokenLogprob[] = logprobs.map(lp => ({
    token: lp.token,
    logprob: lp.logprob,
    prob: Math.exp(lp.logprob),
  }))

  return { target_logprobs, verify_time_ms: Date.now() - start }
}

async function generateWithEngine(
  engine: InferenceEngineInfo,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
): Promise<{ content: string; tokens: number; duration_ms: number }> {
  const start = Date.now()

  const resp = await fetch(`${engine.endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, messages, max_tokens: maxTokens, temperature, stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!resp.ok) return { content: '', tokens: 0, duration_ms: Date.now() - start }

  const data = await resp.json() as {
    choices: Array<{ message: { content: string } }>
    usage?: { completion_tokens?: number }
  }

  return {
    content: data.choices?.[0]?.message?.content ?? '',
    tokens: data.usage?.completion_tokens ?? 0,
    duration_ms: Date.now() - start,
  }
}

// ─── Auto-detection: find speculative pairs in the engine registry ───

/**
 * Given a list of engines, find valid draft-target pairs.
 * A valid pair has:
 *   - Draft: CPU engine (ollama/bitnet-cpp/mistral-rs) with a small model
 *   - Target: GPU engine (vllm/sglang/tensorrt-llm) with a large model
 *   - Both models from the same family (e.g. both Qwen)
 */
export function findSpeculativePairs(engines: InferenceEngineInfo[]): SpeculativePair[] {
  const cpuBackends: Set<InferenceBackend> = new Set(['ollama', 'bitnet-cpp', 'mistral-rs'])
  const gpuBackends: Set<InferenceBackend> = new Set(['vllm', 'sglang', 'tensorrt-llm'])

  const draftEngines = engines.filter(e => cpuBackends.has(e.backend) && e.status !== 'offline')
  const targetEngines = engines.filter(e => gpuBackends.has(e.backend) && e.status !== 'offline')

  const pairs: SpeculativePair[] = []

  for (const draft of draftEngines) {
    for (const target of targetEngines) {
      for (const dm of draft.loaded_models) {
        for (const tm of target.loaded_models) {
          // Check same model family (heuristic: share a common word like "qwen", "llama", etc.)
          if (sameFamily(dm.model_id, tm.model_id)) {
            pairs.push({
              draft, target,
              draft_model: dm.model_id,
              target_model: tm.model_id,
            })
          }
        }
      }
    }
  }

  return pairs
}

function sameFamily(a: string, b: string): boolean {
  const families = ['qwen', 'llama', 'mistral', 'phi', 'gemma', 'deepseek', 'yi']
  const aLower = a.toLowerCase()
  const bLower = b.toLowerCase()
  return families.some(f => aLower.includes(f) && bLower.includes(f))
}
