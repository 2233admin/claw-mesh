/**
 * Pluggable runtime abstraction for task execution
 * Implementations: DockerRunner, NativeRunner, LxcRunner, WasmRunner
 */

/** Resource limits for a spawned agent/task */
export interface ResourceSpec {
  memory_mb?: number
  cpu_cores?: number
  gpu?: boolean
  gpu_vram_mb?: number
  timeout_s?: number
  network?: boolean
  writable_paths?: string[]
}

/** Result of a command execution inside a runtime */
export interface ExecResult {
  stdout: string
  stderr: string
  exit_code: number
  duration_ms: number
  oom_killed?: boolean
}

/** Handle to a live agent instance managed by a runtime */
export interface AgentHandle {
  id: string
  runtime: string         // which runtime created this
  device_id: string       // which device it's running on
  started_at: number      // unix ms
  resource_spec: ResourceSpec
}

/** Snapshot of runtime resource utilization */
export interface RuntimeMetrics {
  runtime: string
  active_agents: number
  max_agents: number
  cpu_usage_pct: number
  memory_used_mb: number
  gpu_usage_pct?: number
  gpu_vram_used_mb?: number
}

/**
 * Common interface all runtime implementations must satisfy.
 * Implementations are responsible for sandbox isolation appropriate
 * to their environment (cgroups, bubblewrap, gVisor, etc.).
 */
export interface TaskRunner {
  readonly name: string

  // Lifecycle
  spawn(task: { id: string; image?: string; commands: string[] }, resources: ResourceSpec): Promise<AgentHandle>
  run(handle: AgentHandle, cmd: string, timeout_s?: number): Promise<ExecResult>
  cleanup(handle: AgentHandle): Promise<void>

  // Observability
  getMetrics(): Promise<RuntimeMetrics>

  // Health check called before scheduling
  isAvailable(): Promise<boolean>
}
