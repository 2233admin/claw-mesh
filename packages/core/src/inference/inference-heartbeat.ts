/**
 * Inference Engine Heartbeat
 *
 * Independent from device heartbeat (30s) — inference engines crash more often
 * (OOM, CUDA errors, model loading failures), so we probe every 15s.
 *
 * Responsibilities:
 *  1. Probe each local engine's health endpoint
 *  2. Update engine status + loaded models in Redis
 *  3. Collect throughput metrics from engine /metrics endpoints
 *  4. Deregister engines that fail 3 consecutive checks
 */

import type Redis from 'ioredis'
import type { InferenceEngineInfo, InferenceBackend, LoadedModel } from '../types/inference'
import { registerEngine, deregisterEngine } from './engine-registry'

const HEARTBEAT_INTERVAL_MS = 15_000
const MAX_CONSECUTIVE_FAILURES = 3

interface EngineProbe {
  engine: InferenceEngineInfo
  consecutiveFailures: number
}

let _timer: ReturnType<typeof setInterval> | null = null
const _probes: Map<string, EngineProbe> = new Map()

// ─── Engine health probing ───

async function probeHealth(engine: InferenceEngineInfo): Promise<boolean> {
  const endpoint = engine.health_endpoint ?? `${engine.endpoint}/health`
  try {
    const resp = await fetch(endpoint, { signal: AbortSignal.timeout(5000) })
    return resp.ok
  } catch {
    return false
  }
}

/**
 * Fetch loaded models from an engine's OpenAI-compatible /v1/models endpoint.
 */
async function fetchModels(engine: InferenceEngineInfo): Promise<LoadedModel[] | null> {
  try {
    const resp = await fetch(`${engine.endpoint}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return null

    const data = await resp.json() as {
      data: Array<{ id: string; max_model_len?: number; created?: number }>
    }

    return (data.data ?? []).map(m => ({
      model_id: m.id,
      context_length: m.max_model_len ?? 4096,
      loaded_at: (m.created ?? Math.floor(Date.now() / 1000)) * 1000,
    }))
  } catch {
    return null
  }
}

/**
 * Fetch throughput from vLLM/SGLang /metrics (Prometheus format).
 * Extracts tokens_per_second from the metrics.
 */
async function fetchThroughput(engine: InferenceEngineInfo): Promise<number | undefined> {
  if (!['vllm', 'sglang'].includes(engine.backend)) return undefined
  try {
    const resp = await fetch(`${engine.endpoint}/metrics`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!resp.ok) return undefined
    const text = await resp.text()

    // vLLM: vllm:avg_generation_throughput_toks_per_s
    // SGLang: sglang:token_throughput
    const match = text.match(/(?:avg_generation_throughput_toks_per_s|token_throughput)\s+([\d.]+)/)
    return match ? parseFloat(match[1]) : undefined
  } catch {
    return undefined
  }
}

// ─── Heartbeat tick ───

async function tick(redis: Redis): Promise<void> {
  for (const [id, probe] of _probes) {
    const healthy = await probeHealth(probe.engine)

    if (healthy) {
      probe.consecutiveFailures = 0

      // Refresh engine info
      const [models, tps] = await Promise.all([
        fetchModels(probe.engine),
        fetchThroughput(probe.engine),
      ])

      const updated: InferenceEngineInfo = {
        ...probe.engine,
        status: 'online',
        last_health_check: Date.now(),
        loaded_models: models ?? probe.engine.loaded_models,
        tokens_per_second: tps ?? probe.engine.tokens_per_second,
      }

      probe.engine = updated
      await registerEngine(redis, updated)
    } else {
      probe.consecutiveFailures++

      if (probe.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // Engine is dead — deregister
        console.error(
          `[inference-heartbeat] ${probe.engine.backend}@${probe.engine.device_id} ` +
          `failed ${MAX_CONSECUTIVE_FAILURES}x, deregistering`
        )
        await deregisterEngine(redis, probe.engine.device_id, probe.engine.backend)
        _probes.delete(id)
      } else {
        // Mark degraded
        const updated: InferenceEngineInfo = {
          ...probe.engine,
          status: 'degraded',
          last_health_check: Date.now(),
        }
        probe.engine = updated
        await registerEngine(redis, updated)
      }
    }
  }
}

// ─── Public API ───

/**
 * Add an engine to the heartbeat monitoring loop.
 */
export function trackEngine(engine: InferenceEngineInfo): void {
  const id = `${engine.device_id}:${engine.backend}`
  _probes.set(id, { engine, consecutiveFailures: 0 })
}

/**
 * Remove an engine from monitoring.
 */
export function untrackEngine(deviceId: string, backend: InferenceBackend): void {
  _probes.delete(`${deviceId}:${backend}`)
}

/**
 * Start the inference heartbeat loop (15s interval).
 * Call trackEngine() first to register engines to monitor.
 */
export function startInferenceHeartbeat(redis: Redis): void {
  if (_timer !== null) return

  _timer = setInterval(async () => {
    try {
      await tick(redis)
    } catch (err) {
      console.error('[inference-heartbeat] tick error:', err)
    }
  }, HEARTBEAT_INTERVAL_MS)

  // Immediate first tick
  tick(redis).catch(err =>
    console.error('[inference-heartbeat] initial tick error:', err)
  )
}

/**
 * Stop the heartbeat loop. Safe to call multiple times.
 */
export function stopInferenceHeartbeat(): void {
  if (_timer !== null) {
    clearInterval(_timer)
    _timer = null
  }
}

/**
 * Get current status of all tracked engines.
 */
export function getTrackedEngines(): InferenceEngineInfo[] {
  return Array.from(_probes.values()).map(p => p.engine)
}
