/**
 * Inference Engine Abstraction Layer
 *
 * Supports heterogeneous inference backends:
 *   GPU:  vLLM, SGLang, TensorRT-LLM
 *   CPU:  BitNet.cpp, mistral.rs, Ollama
 *   Edge: ExLlamaV2, PowerInfer
 *   Distributed: Mooncake (prefill/decode separation)
 *
 * Design: engines register capabilities; the InferenceRouter picks
 * the best engine for each request based on task type + device state.
 */

// ─── Engine identity ───

export type InferenceBackend =
  | 'vllm'
  | 'sglang'
  | 'tensorrt-llm'
  | 'ollama'
  | 'bitnet-cpp'
  | 'mistral-rs'
  | 'exllamav2'
  | 'powerinfer'
  | 'mooncake'
  | 'litellm'       // gateway aggregator

export type InferenceTaskType =
  | 'chat'           // conversational
  | 'completion'     // raw completion
  | 'structured'     // JSON / code generation (SGLang excels)
  | 'embedding'      // vector embedding
  | 'batch'          // offline batch processing

export type QuantizationType =
  | 'fp16' | 'bf16' | 'fp8' | 'int8' | 'int4'
  | 'gptq' | 'awq' | 'gguf' | 'exl2'
  | '1bit'           // BitNet

// ─── Engine capability descriptor ───

export interface InferenceEngineInfo {
  backend: InferenceBackend
  device_id: string              // which mesh node runs this engine
  endpoint: string               // http://host:port
  health_endpoint?: string       // /health or /v1/models

  // What it can do
  supported_tasks: InferenceTaskType[]
  max_concurrent_requests: number
  max_context_length: number     // tokens

  // Hardware affinity
  requires_gpu: boolean
  min_vram_mb?: number
  supports_quantization: QuantizationType[]

  // Performance characteristics
  tokens_per_second?: number     // measured throughput
  time_to_first_token_ms?: number
  prefill_tokens_per_second?: number

  // Loaded models
  loaded_models: LoadedModel[]

  // State
  status: 'online' | 'loading' | 'degraded' | 'offline'
  last_health_check: number      // unix ms
}

export interface LoadedModel {
  model_id: string               // e.g. "Qwen/Qwen2.5-72B-Instruct"
  alias?: string                 // short name for routing
  quantization?: QuantizationType
  vram_used_mb?: number
  context_length: number
  loaded_at: number              // unix ms
}

// ─── Inference request/response ───

export interface InferenceRequest {
  task_type: InferenceTaskType
  model?: string                 // requested model (or let router pick)
  messages?: ChatMessage[]       // for chat/completion
  prompt?: string                // for raw completion
  schema?: unknown               // JSON schema for structured output

  // Constraints
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string[]

  // Routing hints
  prefer_backend?: InferenceBackend
  prefer_device?: string         // device_id
  require_local?: boolean        // must run on local model, not cloud
  priority?: 'low' | 'normal' | 'high'
  timeout_ms?: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface InferenceResponse {
  request_id: string
  engine: InferenceBackend
  device_id: string
  model: string

  // Output
  content: string
  finish_reason: 'stop' | 'length' | 'error'
  usage: TokenUsage

  // Perf
  time_to_first_token_ms?: number
  total_duration_ms: number
  tokens_per_second?: number
}

export interface TokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

// ─── Routing decision ───

export interface RoutingDecision {
  engine: InferenceEngineInfo
  model: LoadedModel
  score: number
  reason: string
}

// ─── Scoring weights for inference routing ───

export interface InferenceRoutingWeights {
  throughput: number        // default 0.30 — tokens/s
  latency: number           // default 0.25 — TTFT
  cost: number              // default 0.20 — local > cloud
  capability: number        // default 0.15 — structured output support etc
  locality: number          // default 0.10 — same device / low-latency link
}

export const DEFAULT_INFERENCE_WEIGHTS: InferenceRoutingWeights = {
  throughput: 0.30,
  latency: 0.25,
  cost: 0.20,
  capability: 0.15,
  locality: 0.10,
}

// ─── Redis keys for inference registry ───

export const INFERENCE_REDIS_KEYS = {
  engine: (id: string) => `fsc:inference:engine:${id}`,
  engineSet: 'fsc:inference:engines',
  routingStats: (backend: string) => `fsc:inference:stats:${backend}`,
  modelIndex: 'fsc:inference:models',  // hash: model_id → engine_id[]
} as const
