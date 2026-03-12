import { describe, it, expect } from 'vitest'
import { rankEngines, routeInference } from '../inference-router'
import type { InferenceEngineInfo, InferenceRequest } from '../../types/inference'

// ─── Test fixtures ───

function makeEngine(overrides: Partial<InferenceEngineInfo>): InferenceEngineInfo {
  return {
    backend: 'vllm',
    device_id: 'super',
    endpoint: 'http://10.10.0.5:8000',
    supported_tasks: ['chat', 'completion', 'structured', 'embedding', 'batch'],
    max_concurrent_requests: 64,
    max_context_length: 32768,
    requires_gpu: true,
    supports_quantization: ['fp16', 'bf16', 'fp8'],
    loaded_models: [{
      model_id: 'Qwen/Qwen2.5-72B-Instruct',
      alias: 'qwen-72b',
      quantization: 'fp16',
      context_length: 32768,
      loaded_at: Date.now(),
    }],
    status: 'online',
    last_health_check: Date.now(),
    tokens_per_second: 150,
    time_to_first_token_ms: 50,
    ...overrides,
  }
}

const vllmEngine = makeEngine({})

const sglangEngine = makeEngine({
  backend: 'sglang',
  endpoint: 'http://10.10.0.5:8001',
  tokens_per_second: 120,
  time_to_first_token_ms: 30,
})

const ollamaEngine = makeEngine({
  backend: 'ollama',
  device_id: 'central',
  endpoint: 'http://10.10.0.1:11434',
  requires_gpu: false,
  tokens_per_second: 15,
  time_to_first_token_ms: 200,
  loaded_models: [{
    model_id: 'qwen2.5-coder:7b',
    context_length: 8192,
    loaded_at: Date.now(),
  }],
  supports_quantization: ['gguf'],
})

const litellmEngine = makeEngine({
  backend: 'litellm',
  device_id: 'super',
  endpoint: 'http://10.10.0.5:4000',
  requires_gpu: false,
  tokens_per_second: 80,
  time_to_first_token_ms: 300,
  loaded_models: [
    { model_id: 'gpt-4o', context_length: 128000, loaded_at: Date.now() },
    { model_id: 'claude-sonnet-4-20250514', context_length: 200000, loaded_at: Date.now() },
  ],
  supports_quantization: [],
})

const bitnetEngine = makeEngine({
  backend: 'bitnet-cpp',
  device_id: 'silicon-valley',
  endpoint: 'http://10.10.0.2:8080',
  requires_gpu: false,
  tokens_per_second: 30,
  time_to_first_token_ms: 100,
  loaded_models: [{
    model_id: 'BitNet-b1.58-2B',
    quantization: '1bit',
    context_length: 4096,
    loaded_at: Date.now(),
  }],
  supports_quantization: ['1bit'],
})

const allEngines = [vllmEngine, sglangEngine, ollamaEngine, litellmEngine, bitnetEngine]

// ─── Tests ───

describe('rankEngines', () => {
  it('returns empty array when no engines available', () => {
    const result = rankEngines([], { task_type: 'chat' })
    expect(result).toEqual([])
  })

  it('filters out offline engines', () => {
    const offline = makeEngine({ status: 'offline' })
    const result = rankEngines([offline], { task_type: 'chat' })
    expect(result).toHaveLength(0)
  })

  it('filters engines by task type support', () => {
    const chatOnly = makeEngine({ supported_tasks: ['chat'] })
    const result = rankEngines([chatOnly], { task_type: 'embedding' })
    expect(result).toHaveLength(0)
  })

  it('ranks vLLM highest for chat throughput', () => {
    const result = rankEngines(allEngines, { task_type: 'chat' })
    expect(result.length).toBeGreaterThan(0)
    // vLLM has highest throughput → should rank near top
    expect(result[0].engine.backend).toBe('vllm')
  })

  it('ranks SGLang highest for structured output', () => {
    const result = rankEngines(allEngines, { task_type: 'structured' })
    expect(result.length).toBeGreaterThan(0)
    // SGLang has best capability score for structured
    expect(result[0].engine.backend).toBe('sglang')
  })

  it('respects prefer_backend constraint', () => {
    const request: InferenceRequest = {
      task_type: 'chat',
      prefer_backend: 'ollama',
    }
    const result = rankEngines(allEngines, request)
    expect(result).toHaveLength(1)
    expect(result[0].engine.backend).toBe('ollama')
  })

  it('respects require_local — excludes litellm', () => {
    const request: InferenceRequest = {
      task_type: 'chat',
      require_local: true,
    }
    const result = rankEngines(allEngines, request)
    expect(result.every(d => d.engine.backend !== 'litellm')).toBe(true)
  })

  it('matches requested model', () => {
    const request: InferenceRequest = {
      task_type: 'chat',
      model: 'qwen-72b',
    }
    const result = rankEngines(allEngines, request)
    // Only engines with qwen-72b loaded should match
    expect(result.every(d =>
      d.model.model_id.includes('Qwen') || d.model.alias?.includes('qwen')
    )).toBe(true)
  })

  it('boosts score for high priority', () => {
    const normal = rankEngines(allEngines, { task_type: 'chat', priority: 'normal' })
    const high = rankEngines(allEngines, { task_type: 'chat', priority: 'high' })
    // Same order, but high priority scores should be 1.2x
    if (normal.length > 0 && high.length > 0) {
      expect(high[0].score).toBeGreaterThan(normal[0].score)
    }
  })

  it('prefers same device when prefer_device set', () => {
    const request: InferenceRequest = {
      task_type: 'chat',
      prefer_device: 'super',
    }
    const result = rankEngines(allEngines, request)
    expect(result[0].engine.device_id).toBe('super')
  })
})

describe('routeInference', () => {
  it('returns null when no engine matches', () => {
    const result = routeInference([], { task_type: 'chat' })
    expect(result).toBeNull()
  })

  it('returns best engine for chat', () => {
    const result = routeInference(allEngines, { task_type: 'chat' })
    expect(result).not.toBeNull()
    expect(result!.engine.backend).toBe('vllm')
  })

  it('returns best engine for structured', () => {
    const result = routeInference(allEngines, { task_type: 'structured' })
    expect(result).not.toBeNull()
    expect(result!.engine.backend).toBe('sglang')
  })

  it('falls back to CPU engine when GPU unavailable', () => {
    const cpuOnly = [ollamaEngine, bitnetEngine]
    const result = routeInference(cpuOnly, { task_type: 'chat' })
    expect(result).not.toBeNull()
    expect(['ollama', 'bitnet-cpp']).toContain(result!.engine.backend)
  })

  it('includes reason in decision', () => {
    const result = routeInference(allEngines, { task_type: 'structured' })
    expect(result!.reason).toContain('RadixAttention')
  })
})
