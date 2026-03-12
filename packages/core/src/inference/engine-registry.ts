/**
 * Inference Engine Registry
 *
 * Manages the fleet of inference engines across the mesh.
 * Engines register on startup, update health periodically,
 * and get deregistered on timeout.
 *
 * Backed by Redis for cross-node visibility.
 */

import type Redis from 'ioredis'
import type { InferenceEngineInfo, InferenceBackend } from '../types/inference'
import { INFERENCE_REDIS_KEYS } from '../types/inference'

const ENGINE_TTL_S = 120 // engines expire if no heartbeat for 2 minutes

/**
 * Register or update an inference engine in the mesh registry.
 */
export async function registerEngine(
  redis: Redis,
  engine: InferenceEngineInfo,
): Promise<void> {
  const engineId = `${engine.device_id}:${engine.backend}`
  const key = INFERENCE_REDIS_KEYS.engine(engineId)

  await redis.set(key, JSON.stringify(engine), 'EX', ENGINE_TTL_S)
  await redis.sadd(INFERENCE_REDIS_KEYS.engineSet, engineId)

  // Update model index: model_id → engine_id mapping
  for (const model of engine.loaded_models) {
    await redis.hset(INFERENCE_REDIS_KEYS.modelIndex, model.model_id, engineId)
  }
}

/**
 * Remove an engine from the registry.
 */
export async function deregisterEngine(
  redis: Redis,
  deviceId: string,
  backend: InferenceBackend,
): Promise<void> {
  const engineId = `${deviceId}:${backend}`
  await redis.del(INFERENCE_REDIS_KEYS.engine(engineId))
  await redis.srem(INFERENCE_REDIS_KEYS.engineSet, engineId)
}

/**
 * Get all registered engines (filters out expired keys).
 */
export async function listEngines(redis: Redis): Promise<InferenceEngineInfo[]> {
  const engineIds = await redis.smembers(INFERENCE_REDIS_KEYS.engineSet)
  const engines: InferenceEngineInfo[] = []
  const stale: string[] = []

  for (const id of engineIds) {
    const raw = await redis.get(INFERENCE_REDIS_KEYS.engine(id))
    if (raw) {
      engines.push(JSON.parse(raw) as InferenceEngineInfo)
    } else {
      stale.push(id)
    }
  }

  // Clean up stale entries
  if (stale.length > 0) {
    await redis.srem(INFERENCE_REDIS_KEYS.engineSet, ...stale)
  }

  return engines
}

/**
 * Find engines that have a specific model loaded.
 */
export async function findEnginesByModel(
  redis: Redis,
  modelId: string,
): Promise<InferenceEngineInfo[]> {
  const all = await listEngines(redis)
  return all.filter(e =>
    e.loaded_models.some(m =>
      m.model_id.includes(modelId) || m.alias?.includes(modelId)
    )
  )
}

/**
 * Health-check a single engine and update its status in Redis.
 */
export async function healthCheckEngine(
  redis: Redis,
  engine: InferenceEngineInfo,
): Promise<InferenceEngineInfo> {
  const endpoint = engine.health_endpoint ?? `${engine.endpoint}/health`

  let status: 'online' | 'degraded' | 'offline' = 'offline'
  try {
    const resp = await fetch(endpoint, { signal: AbortSignal.timeout(5000) })
    status = resp.ok ? 'online' : 'degraded'
  } catch {
    status = 'offline'
  }

  const updated: InferenceEngineInfo = {
    ...engine,
    status,
    last_health_check: Date.now(),
  }

  // Re-register with fresh TTL if still alive
  if (status !== 'offline') {
    await registerEngine(redis, updated)
  }

  return updated
}

/**
 * Run health checks on all registered engines.
 */
export async function healthCheckAll(redis: Redis): Promise<InferenceEngineInfo[]> {
  const engines = await listEngines(redis)
  return Promise.all(engines.map(e => healthCheckEngine(redis, e)))
}
