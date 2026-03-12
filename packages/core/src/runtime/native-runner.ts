import type { TaskRunner, AgentHandle, ExecResult, ResourceSpec, RuntimeMetrics } from '../types/runtime'
import { join } from 'path'
import { mkdirSync, rmSync, existsSync } from 'fs'

const DEVICE_ID = process.env.DEVICE_ID ?? 'local'
const TMP_BASE = process.env.NATIVE_RUNNER_TMP ?? '/tmp/claw-native'

/** Check if bubblewrap is available for sandboxing on Linux */
async function hasBwrap(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['bwrap', '--version'], { stdout: 'ignore', stderr: 'ignore' })
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}

/** Build a bubblewrap-sandboxed command prefix */
function bwrapPrefix(workdir: string, writable_paths: string[]): string[] {
  const args = [
    'bwrap',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/sbin', '/sbin',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--bind', workdir, workdir,
    '--chdir', workdir,
  ]
  for (const p of writable_paths) {
    args.push('--bind', p, p)
  }
  args.push('--')
  return args
}

export class NativeRunner implements TaskRunner {
  readonly name = 'native'
  private _bwrap: boolean | null = null

  async isAvailable(): Promise<boolean> {
    return true
  }

  private async useBwrap(): Promise<boolean> {
    if (this._bwrap === null) {
      this._bwrap = process.platform === 'linux' ? await hasBwrap() : false
    }
    return this._bwrap
  }

  async spawn(
    task: { id: string; image?: string; commands: string[] },
    resources: ResourceSpec
  ): Promise<AgentHandle> {
    const workdir = join(TMP_BASE, task.id)
    mkdirSync(workdir, { recursive: true })

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
    const workdir = join(TMP_BASE, handle.id)
    const timeout_ms = timeout_s ? timeout_s * 1000 : undefined
    const spec = handle.resource_spec

    const useSandbox = await this.useBwrap()
    const writable = spec.writable_paths ?? []

    let args: string[]
    if (useSandbox) {
      args = [...bwrapPrefix(workdir, writable), 'sh', '-c', cmd]
    } else {
      args = ['sh', '-c', cmd]
    }

    try {
      const proc = Bun.spawn(args, {
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: existsSync(workdir) ? workdir : undefined,
        timeout: timeout_ms,
      })

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])

      await proc.exited

      return {
        stdout,
        stderr,
        exit_code: proc.exitCode ?? 1,
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
  }

  async getMetrics(): Promise<RuntimeMetrics> {
    // process-level: read /proc/self/status for memory on Linux, otherwise skip
    let memory_used_mb = 0
    let cpu_usage_pct = 0

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
      active_agents: 0, // NativeRunner is stateless; orchestrator tracks active count
      max_agents: parseInt(process.env.MAX_AGENTS ?? '4'),
      cpu_usage_pct,
      memory_used_mb,
    }
  }
}
