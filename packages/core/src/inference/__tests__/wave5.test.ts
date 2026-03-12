/**
 * Wave 5 Tests: Speculative Decoding, Prefill/Decode Router, WASI-NN
 */
import { describe, it, expect } from 'vitest'
import {
  findSpeculativePairs,
  DEFAULT_SPECULATIVE_CONFIG,
  optimalGamma,
} from '../speculative-decoder'
import type { SpeculativePair } from '../speculative-decoder'
import {
  buildPrefillDecodePool,
  DEFAULT_PD_CONFIG,
} from '../prefill-decode-router'
import {
  WasiNNRuntime,
  DEFAULT_WASI_NN_CONFIG,
} from '../wasi-nn-runtime'
import type { InferenceEngineInfo } from '../../types/inference'

// ─── Test engine factories ───

function makeEngine(overrides: Partial<InferenceEngineInfo>): InferenceEngineInfo {
  return {
    backend: 'vllm',
    device_id: 'test-node',
    endpoint: 'http://localhost:8000',
    supported_tasks: ['chat', 'completion'],
    max_concurrent_requests: 10,
    max_context_length: 4096,
    requires_gpu: true,
    supports_quantization: ['fp16'],
    loaded_models: [],
    status: 'online',
    last_health_check: Date.now(),
    ...overrides,
  }
}

// ─── Speculative Decoding ───

describe('findSpeculativePairs', () => {
  it('finds valid draft-target pairs from same model family', () => {
    const engines: InferenceEngineInfo[] = [
      makeEngine({
        backend: 'ollama',
        device_id: 'cpu-node',
        requires_gpu: false,
        loaded_models: [{ model_id: 'qwen2.5-7b', context_length: 4096, loaded_at: Date.now() }],
      }),
      makeEngine({
        backend: 'vllm',
        device_id: 'gpu-node',
        loaded_models: [{ model_id: 'Qwen/Qwen2.5-72B-Instruct', context_length: 32768, loaded_at: Date.now() }],
      }),
    ]

    const pairs = findSpeculativePairs(engines)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].draft_model).toBe('qwen2.5-7b')
    expect(pairs[0].target_model).toBe('Qwen/Qwen2.5-72B-Instruct')
  })

  it('returns empty for mismatched families', () => {
    const engines: InferenceEngineInfo[] = [
      makeEngine({
        backend: 'ollama',
        requires_gpu: false,
        loaded_models: [{ model_id: 'llama-7b', context_length: 4096, loaded_at: Date.now() }],
      }),
      makeEngine({
        backend: 'vllm',
        loaded_models: [{ model_id: 'Qwen/Qwen2.5-72B', context_length: 32768, loaded_at: Date.now() }],
      }),
    ]

    expect(findSpeculativePairs(engines)).toHaveLength(0)
  })

  it('excludes offline engines', () => {
    const engines: InferenceEngineInfo[] = [
      makeEngine({
        backend: 'ollama',
        requires_gpu: false,
        status: 'offline',
        loaded_models: [{ model_id: 'qwen-7b', context_length: 4096, loaded_at: Date.now() }],
      }),
      makeEngine({
        backend: 'vllm',
        loaded_models: [{ model_id: 'qwen-72b', context_length: 32768, loaded_at: Date.now() }],
      }),
    ]

    expect(findSpeculativePairs(engines)).toHaveLength(0)
  })

  it('finds multiple pairs across families', () => {
    const engines: InferenceEngineInfo[] = [
      makeEngine({
        backend: 'ollama', requires_gpu: false,
        loaded_models: [{ model_id: 'qwen-7b', context_length: 4096, loaded_at: Date.now() }],
      }),
      makeEngine({
        backend: 'mistral-rs', requires_gpu: false,
        loaded_models: [{ model_id: 'llama-3b', context_length: 4096, loaded_at: Date.now() }],
      }),
      makeEngine({
        backend: 'vllm',
        loaded_models: [
          { model_id: 'qwen-72b', context_length: 32768, loaded_at: Date.now() },
          { model_id: 'llama-70b', context_length: 32768, loaded_at: Date.now() },
        ],
      }),
    ]

    const pairs = findSpeculativePairs(engines)
    expect(pairs.length).toBeGreaterThanOrEqual(2)
  })
})

describe('DEFAULT_SPECULATIVE_CONFIG', () => {
  it('has sane defaults', () => {
    expect(DEFAULT_SPECULATIVE_CONFIG.draft_length).toBe(5)
    expect(DEFAULT_SPECULATIVE_CONFIG.max_rejections).toBe(3)
    expect(DEFAULT_SPECULATIVE_CONFIG.min_acceptance_rate).toBe(0.3)
    expect(DEFAULT_SPECULATIVE_CONFIG.temperature).toBe(0.7)
    expect(DEFAULT_SPECULATIVE_CONFIG.adaptive_gamma).toBe(true)
    expect(DEFAULT_SPECULATIVE_CONFIG.alpha_ema_factor).toBe(0.3)
  })
})

describe('optimalGamma — γ*(α) ≈ -1/ln(α)', () => {
  it('returns 1 for very low acceptance rate', () => {
    expect(optimalGamma(0.01)).toBe(1)
    expect(optimalGamma(0.1)).toBe(1) // -1/ln(0.1) ≈ 0.43 → clamped to 1
  })

  it('returns ~2-3 for α=0.7', () => {
    const g = optimalGamma(0.7)
    expect(g).toBeGreaterThanOrEqual(2)
    expect(g).toBeLessThanOrEqual(3)
  })

  it('returns ~9-10 for α=0.9', () => {
    const g = optimalGamma(0.9)
    expect(g).toBeGreaterThanOrEqual(9)
    expect(g).toBeLessThanOrEqual(10)
  })

  it('returns 16 for very high acceptance rate', () => {
    expect(optimalGamma(0.99)).toBe(16)
  })

  it('is monotonically increasing with α', () => {
    const alphas = [0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]
    const gammas = alphas.map(optimalGamma)
    for (let i = 1; i < gammas.length; i++) {
      expect(gammas[i]).toBeGreaterThanOrEqual(gammas[i - 1])
    }
  })
})

// ─── Prefill/Decode Router ───

describe('buildPrefillDecodePool', () => {
  it('classifies CPU engines as prefill-only, GPU as decode', () => {
    const engines: InferenceEngineInfo[] = [
      makeEngine({
        backend: 'ollama', device_id: 'central', requires_gpu: false,
        max_context_length: 4096,
        loaded_models: [{ model_id: 'qwen-7b', context_length: 4096, loaded_at: Date.now() }],
      }),
      makeEngine({
        backend: 'vllm', device_id: 'super', requires_gpu: true,
        tokens_per_second: 150,
        loaded_models: [{ model_id: 'qwen-72b', context_length: 32768, loaded_at: Date.now() }],
      }),
    ]

    const pool = buildPrefillDecodePool(engines)
    expect(pool.prefill_nodes).toHaveLength(2) // both ollama and vllm can prefill
    expect(pool.decode_nodes).toHaveLength(1)   // only vllm (GPU) can decode
    expect(pool.decode_nodes[0].device_id).toBe('super')
  })

  it('excludes offline engines from both pools', () => {
    const engines: InferenceEngineInfo[] = [
      makeEngine({ backend: 'ollama', status: 'offline', requires_gpu: false }),
      makeEngine({ backend: 'vllm', status: 'offline' }),
    ]

    const pool = buildPrefillDecodePool(engines)
    expect(pool.prefill_nodes).toHaveLength(0)
    expect(pool.decode_nodes).toHaveLength(0)
  })

  it('sorts decode nodes by throughput descending', () => {
    const engines: InferenceEngineInfo[] = [
      makeEngine({ backend: 'vllm', device_id: 'slow', tokens_per_second: 50,
        loaded_models: [{ model_id: 'm', context_length: 4096, loaded_at: Date.now() }] }),
      makeEngine({ backend: 'sglang', device_id: 'fast', tokens_per_second: 200,
        loaded_models: [{ model_id: 'm', context_length: 4096, loaded_at: Date.now() }] }),
    ]

    const pool = buildPrefillDecodePool(engines)
    expect(pool.decode_nodes[0].device_id).toBe('fast')
  })
})

describe('DEFAULT_PD_CONFIG', () => {
  it('has sane defaults', () => {
    expect(DEFAULT_PD_CONFIG.min_prompt_tokens).toBe(256)
    expect(DEFAULT_PD_CONFIG.enabled).toBe(true)
  })
})

// ─── WASI-NN Runtime ───

describe('WasiNNRuntime', () => {
  it('constructs with default config', () => {
    const nn = new WasiNNRuntime()
    expect(nn).toBeDefined()
    expect(nn.listModels()).toHaveLength(0)
  })

  it('constructs with custom config', () => {
    const nn = new WasiNNRuntime({ threads: 4, context_size: 4096 })
    expect(nn).toBeDefined()
  })

  it('loadModel returns false for non-existent path', () => {
    const nn = new WasiNNRuntime()
    expect(nn.loadModel('/nonexistent/model.gguf')).toBe(false)
    expect(nn.listModels()).toHaveLength(0)
  })

  it('unloadModel returns false for unknown alias', () => {
    const nn = new WasiNNRuntime()
    expect(nn.unloadModel('ghost')).toBe(false)
  })

  it('isAvailable returns false when wasmedge is not installed', async () => {
    const nn = new WasiNNRuntime({ wasmedge_bin: '/nonexistent/wasmedge' })
    expect(await nn.isAvailable()).toBe(false)
  })
})

describe('DEFAULT_WASI_NN_CONFIG', () => {
  it('has sane defaults', () => {
    expect(DEFAULT_WASI_NN_CONFIG.default_backend).toBe('ggml')
    expect(DEFAULT_WASI_NN_CONFIG.n_gpu_layers).toBe(0)
    expect(DEFAULT_WASI_NN_CONFIG.threads).toBe(2)
  })
})
