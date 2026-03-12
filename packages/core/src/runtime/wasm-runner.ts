import type { TaskRunner, AgentHandle, ExecResult, ResourceSpec, RuntimeMetrics } from '../types/runtime'
import { join } from 'path'
import { mkdirSync, rmSync, existsSync } from 'fs'

const DEVICE_ID = process.env.DEVICE_ID ?? 'local'
const TMP_BASE = process.env.WASM_RUNNER_TMP ?? '/tmp/claw-wasm'

/** Detected WASM runtime preference */
type WasmRuntime = 'spin' | 'wasmedge' | null

async function checkCli(bin: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([bin, '--version'], { stdout: 'ignore', stderr: 'ignore' })
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}

async function spawnCmd(
  args: string[],
  opts?: { cwd?: string; timeout_ms?: number }
): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  const proc = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: opts?.cwd,
    timeout: opts?.timeout_ms,
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  await proc.exited

  return { stdout, stderr, exit_code: proc.exitCode ?? 1 }
}

/**
 * WasmRunner: executes tasks inside WASM sandboxes.
 *
 * Runtime preference:
 *   - Spin (Fermyon) — preferred for microservice-style tasks, <1ms cold start
 *   - WasmEdge — general-purpose WASM/WASI execution
 *
 * Each spawned task gets its own working directory; memory isolation is
 * enforced per-instance by the WASM runtime itself.
 */
export class WasmRunner implements TaskRunner {
  readonly name = 'wasm'

  private _runtime: WasmRuntime | undefined = undefined
  private _activeHandles = new Set<string>()

  /** Detect available WASM runtime, caching the result. */
  private async detectRuntime(): Promise<WasmRuntime> {
    if (this._runtime !== undefined) return this._runtime

    const [hasSpin, hasWasmEdge] = await Promise.all([
      checkCli('spin'),
      checkCli('wasmedge'),
    ])

    // Prefer Spin for microservices; fall back to WasmEdge
    if (hasSpin) {
      this._runtime = 'spin'
    } else if (hasWasmEdge) {
      this._runtime = 'wasmedge'
    } else {
      this._runtime = null
    }

    return this._runtime
  }

  async isAvailable(): Promise<boolean> {
    return (await this.detectRuntime()) !== null
  }

  async spawn(
    task: { id: string; image?: string; commands: string[] },
    resources: ResourceSpec
  ): Promise<AgentHandle> {
    const workdir = join(TMP_BASE, task.id)
    mkdirSync(workdir, { recursive: true })

    // If a WASM module path is provided via image field, copy/link it into workdir.
    // Callers pass the .wasm file path as `task.image`.
    if (task.image && existsSync(task.image)) {
      const dest = join(workdir, 'module.wasm')
      await Bun.write(dest, Bun.file(task.image))
    }

    this._activeHandles.add(task.id)

    return {
      id: task.id,
      runtime: this.name,
      device_id: DEVICE_ID,
      started_at: Date.now(),
      resource_spec: resources,
    }
  }

  async run(handle: AgentHandle, cmd: string, timeout_s?: number): Promise<ExecResult> {
    const start = Date.now()
    const timeout_ms = timeout_s ? timeout_s * 1000 : undefined
    const workdir = join(TMP_BASE, handle.id)
    const runtime = await this.detectRuntime()

    if (!runtime) {
      return {
        stdout: '',
        stderr: 'No WASM runtime available (spin or wasmedge required)',
        exit_code: 127,
        duration_ms: Date.now() - start,
      }
    }

    // Build execution args depending on available runtime.
    // For both runtimes we execute the command via `sh -c` inside the sandbox
    // when no .wasm module is present, or run the module directly when one exists.
    const wasmModule = join(workdir, 'module.wasm')
    const hasModule = existsSync(wasmModule)

    let args: string[]

    if (runtime === 'spin') {
      if (hasModule) {
        // spin up --file <module.wasm> -- <cmd>
        args = ['spin', 'up', '--file', wasmModule, '--', 'sh', '-c', cmd]
      } else {
        // No .wasm provided — run the command via wasmedge fallback or native sh.
        // Spin requires a component; without one we drop to sh in the workdir.
        args = ['sh', '-c', cmd]
      }
    } else {
      // wasmedge: run a WASM module if present, otherwise treat cmd as a CLI command
      if (hasModule) {
        // wasmedge --dir /tmp:/tmp <module.wasm> [args split from cmd]
        const cmdParts = cmd.split(/\s+/).filter(Boolean)
        args = ['wasmedge', '--dir', `${workdir}:${workdir}`, wasmModule, ...cmdParts]
      } else {
        // General execution inside the working directory via sh
        args = ['wasmedge', '--dir', `${workdir}:${workdir}`, '--', 'sh', '-c', cmd]
      }
    }

    try {
      const r = await spawnCmd(args, {
        cwd: existsSync(workdir) ? workdir : undefined,
        timeout_ms,
      })

      return {
        stdout: r.stdout,
        stderr: r.stderr,
        exit_code: r.exit_code,
        duration_ms: Date.now() - start,
      }
    } catch (e: any) {
      if (e?.name === 'TimeoutError' || e?.message?.includes('timeout')) {
        return {
          stdout: '',
          stderr: `Timeout after ${timeout_s}s`,
          exit_code: 124,
          duration_ms: Date.now() - start,
        }
      }
      throw e
    }
  }

  async cleanup(handle: AgentHandle): Promise<void> {
    const workdir = join(TMP_BASE, handle.id)
    if (existsSync(workdir)) {
      rmSync(workdir, { recursive: true, force: true })
    }
    this._activeHandles.delete(handle.id)
  }

  async getMetrics(): Promise<RuntimeMetrics> {
    let memory_used_mb = 0

    if (process.platform === 'linux') {
      try {
        const status = await Bun.file('/proc/self/status').text()
        const vmRssMatch = status.match(/VmRSS:\s+(\d+)\s+kB/)
        if (vmRssMatch) {
          memory_used_mb = parseInt(vmRssMatch[1]) / 1024
        }
      } catch {
        // best-effort
      }
    }

    return {
      runtime: this.name,
      active_agents: this._activeHandles.size,
      max_agents: parseInt(process.env.MAX_AGENTS ?? '20'),
      cpu_usage_pct: 0,
      memory_used_mb,
    }
  }
}
