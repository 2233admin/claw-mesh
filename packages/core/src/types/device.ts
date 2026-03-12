/**
 * Device capability model for heterogeneous mesh
 * Supports: Linux x86, macOS ARM, Android, iOS, Windows, NVIDIA GPU nodes
 */

export type Platform = 'linux' | 'darwin' | 'android' | 'ios' | 'windows'
export type Arch = 'x86_64' | 'aarch64' | 'armv7'
export type Runtime = 'docker' | 'podman' | 'native' | 'bun' | 'python' | 'lxc' | 'wasm' | 'gvisor'
export type NetworkType = 'wired' | 'wifi' | 'cellular'
export type NatType = 'public' | 'full_cone' | 'restricted' | 'symmetric' | 'relay_only'
export type TrustLevel = 'trusted' | 'verified' | 'community'

/** GPU hardware info, supporting NVIDIA CUDA and Apple Metal */
export interface GpuInfo {
  name: string                    // "RTX 5090", "Apple M4 GPU"
  vendor: 'nvidia' | 'amd' | 'apple' | 'intel' | 'unknown'
  vram_mb: number
  cuda_cores?: number
  compute_capability?: string     // CUDA compute capability e.g. "9.0"
  metal_family?: number           // Apple Metal GPU family
  utilization_pct: number
  temperature_c?: number
  power_watts?: number
}

/**
 * Full capability descriptor for a mesh node.
 * Serialized to Redis at fsc:device:{id} with TTL, refreshed on heartbeat.
 */
export interface DeviceCapability {
  device_id: string
  hostname: string

  // Platform
  platform: Platform
  arch: Arch

  // Compute
  cpu_cores: number
  cpu_model: string
  memory_total_mb: number
  memory_available_mb: number
  disk_total_gb: number
  disk_available_gb: number

  // GPU
  gpus: GpuInfo[]

  // Runtimes available on this node
  runtimes: Runtime[]

  // Network
  network_type: NetworkType
  nat_type: NatType
  relay_node?: string
  latency_to_relay_ms?: number
  bandwidth_mbps?: number

  // Mesh identity — at least one should be set
  netbird_ip?: string             // NetBird mesh IP
  iroh_node_id?: string           // iroh public key (base32)
  wireguard_ip?: string           // Legacy WireGuard IP

  // Task execution capabilities
  can_run_tasks: boolean
  can_serve_inference: boolean
  inference_models: string[]      // loaded model IDs e.g. ["qwen2.5-coder:7b"]
  max_concurrent_tasks: number

  // Trust & security
  trust_level: TrustLevel
  sandbox_available: boolean      // bubblewrap / landlock / gvisor

  // Power state (mobile / laptop)
  battery_pct?: number
  charging?: boolean

  // Lifecycle
  online_since: number            // unix ms
  last_heartbeat: number          // unix ms
  ephemeral: boolean              // may go offline anytime (mobile/laptop)

  // Custom scheduling hints
  tags: string[]
}

/**
 * Task placement constraints.
 * Hard constraints filter candidates; soft constraints affect scoring.
 */
export interface TaskRequirement {
  // Hard constraints (must match)
  min_memory_mb?: number
  min_vram_mb?: number
  required_runtime?: Runtime
  required_platforms?: Platform[]
  required_gpu?: boolean
  required_trust?: TrustLevel
  min_disk_gb?: number

  // Soft constraints (affect scoring)
  prefer_gpu?: boolean
  prefer_low_latency?: boolean
  prefer_stable?: boolean         // avoid ephemeral devices
  prefer_local_model?: string     // prefer node with this model already loaded
  estimated_duration_s?: number
  estimated_memory_mb?: number
  required_tags?: string[]
}

/** Scoring weights for capability matching. Must sum to 1.0. */
export interface SchedulerWeights {
  idle_capacity: number           // default 0.40
  hardware_fit: number            // default 0.25
  network_quality: number         // default 0.15
  trust_score: number             // default 0.15
  affinity: number                // default 0.05
}

export const DEFAULT_WEIGHTS: SchedulerWeights = {
  idle_capacity: 0.40,
  hardware_fit: 0.25,
  network_quality: 0.15,
  trust_score: 0.15,
  affinity: 0.05,
}

/** Redis key helpers for device registry */
export const REDIS_KEYS = {
  device: (id: string) => `fsc:device:${id}`,
  deviceSet: 'fsc:devices',
  inference: (id: string) => `fsc:inference:${id}`,
  inferenceSet: 'fsc:inference:available',
} as const
