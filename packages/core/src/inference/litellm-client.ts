/**
 * LiteLLM Gateway Client
 *
 * Wraps the LiteLLM proxy as an InferenceEngineInfo provider.
 * LiteLLM unifies 100+ LLM providers behind OpenAI-compatible API,
 * handling auth, rate limits, fallbacks, and budget tracking.
 *
 * This client:
 *  1. Polls /model/info to discover available models
 *  2. Registers as an InferenceEngineInfo in the mesh registry
 *  3. Provides health checking via /health/liveliness
 */

import type { InferenceEngineInfo, LoadedModel, InferenceTaskType } from '../types/inference'

export interface LiteLLMClientConfig {
  endpoint: string           // e.g. http://10.10.0.5:4000
  api_key?: string           // master key for LiteLLM proxy
  device_id: string          // mesh node running the proxy
  poll_interval_ms?: number  // default 60_000
}

interface LiteLLMModelInfo {
  model_name: string
  litellm_params: {
    model: string
    api_base?: string
    api_key?: string
  }
  model_info?: {
    max_tokens?: number
    max_input_tokens?: number
  }
}

/**
 * Build an InferenceEngineInfo from LiteLLM's /model/info endpoint.
 */
export async function discoverLiteLLMModels(
  config: LiteLLMClientConfig,
): Promise<InferenceEngineInfo> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.api_key) {
    headers['Authorization'] = `Bearer ${config.api_key}`
  }

  // Fetch model list
  const resp = await fetch(`${config.endpoint}/model/info`, { headers })
  if (!resp.ok) {
    throw new Error(`LiteLLM /model/info failed: ${resp.status}`)
  }

  const data = await resp.json() as { data: LiteLLMModelInfo[] }
  const models: LoadedModel[] = (data.data ?? []).map(m => ({
    model_id: m.model_name,
    alias: m.litellm_params.model,
    context_length: m.model_info?.max_tokens ?? m.model_info?.max_input_tokens ?? 4096,
    loaded_at: Date.now(),
  }))

  // Health check
  let status: 'online' | 'offline' = 'offline'
  try {
    const health = await fetch(`${config.endpoint}/health/liveliness`)
    status = health.ok ? 'online' : 'offline'
  } catch {
    status = 'offline'
  }

  const taskTypes: InferenceTaskType[] = ['chat', 'completion', 'structured', 'embedding']

  return {
    backend: 'litellm',
    device_id: config.device_id,
    endpoint: config.endpoint,
    health_endpoint: `${config.endpoint}/health/liveliness`,
    supported_tasks: taskTypes,
    max_concurrent_requests: 100,
    max_context_length: Math.max(...models.map(m => m.context_length), 4096),
    requires_gpu: false,
    supports_quantization: [],
    loaded_models: models,
    status,
    last_health_check: Date.now(),
  }
}

/**
 * Check if LiteLLM proxy is healthy.
 */
export async function checkLiteLLMHealth(endpoint: string): Promise<boolean> {
  try {
    const resp = await fetch(`${endpoint}/health/liveliness`, {
      signal: AbortSignal.timeout(5000),
    })
    return resp.ok
  } catch {
    return false
  }
}
