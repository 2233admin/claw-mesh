import type { TaskRunner, AgentHandle, ExecResult, ResourceSpec, RuntimeMetrics } from '../types/runtime'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'

const DEVICE_ID = process.env.DEVICE_ID ?? 'local'
const BUNDLE_BASE = process.env.GVISOR_BUNDLE_BASE ?? '/tmp/claw-gvisor'

async function spawnCmd(
  args: string[],
  timeout_ms?: number,
): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  const proc = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeout_ms,
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  await proc.exited

  return { stdout, stderr, exit_code: proc.exitCode ?? 1 }
}

/** Check if runsc binary exists in PATH */
async function hasRunsc(): Promise<boolean> {
  try {
    const r = await spawnCmd(['runsc', '--version'])
    return r.exit_code === 0
  } catch {
    return false
  }
}

/** Check if Docker has runsc configured as a runtime */
async function dockerHasRunsc(): Promise<boolean> {
  try {
    const r = await spawnCmd(['docker', 'info', '--format', '{{json .Runtimes}}'])
    if (r.exit_code !== 0) return false
    return r.stdout.includes('runsc')
  } catch {
    return false
  }
}

/** Minimal OCI config.json for a gVisor sandbox */
function buildOciConfig(resources: ResourceSpec): object {
  const memLimit = resources.memory_mb ? resources.memory_mb * 1024 * 1024 : 512 * 1024 * 1024
  return {
    ociVersion: '1.0.2',
    process: {
      terminal: false,
      user: { uid: 0, gid: 0 },
      args: ['sleep', '999999'],
      env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
      cwd: '/',
      capabilities: {
        bounding: ['CAP_NET_BIND_SERVICE'],
        effective: ['CAP_NET_BIND_SERVICE'],
        permitted: ['CAP_NET_BIND_SERVICE'],
      },
      noNewPrivileges: true,
    },
    root: { path: 'rootfs', readonly: false },
    hostname: 'claw-gvisor',
    mounts: [
      { destination: '/proc', type: 'proc', source: 'proc', options: [] },
      { destination: '/dev', type: 'tmpfs', source: 'tmpfs', options: ['nosuid', 'strictatime', 'mode=755', 'size=65536k'] },
      { destination: '/sys', type: 'sysfs', source: 'sysfs', options: ['nosuid', 'noexec', 'nodev', 'ro'] },
      { destination: '/tmp', type: 'tmpfs', source: 'tmpfs', options: [] },
    ],
    linux: {
      namespaces: [
        { type: 'pid' },
        { type: 'network' },
        { type: 'ipc' },
        { type: 'uts' },
        { type: 'mount' },
      ],
      resources: {
        memory: { limit: memLimit },
      },
    },
  }
}

export class GVisorRunner implements TaskRunner {
  readonly name = 'gvisor'

  private _mode: 'docker' | 'standalone' | null = null

  private async resolveMode(): Promise<'docker' | 'standalone' | null> {
    if (this._mode !== null) return this._mode
    // Prefer Docker+gVisor when both are available (more mature, easier lifecycle)
    const [dockerOk, runscOk] = await Promise.all([dockerHasRunsc(), hasRunsc()])
    if (dockerOk) {
      this._mode = 'docker'
    } else if (runscOk) {
      this._mode = 'standalone'
    } else {
      this._mode = null
    }
    return this._mode
  }

  async isAvailable(): Promise<boolean> {
    return (await this.resolveMode()) !== null
  }

  async spawn(
    task: { id: string; image?: string; commands: string[] },
    resources: ResourceSpec,
  ): Promise<AgentHandle> {
    const mode = await this.resolveMode()
    if (!mode) {
      throw new Error('gVisor unavailable: neither docker+runsc nor standalone runsc found')
    }

    if (mode === 'docker') {
      return this._spawnDocker(task, resources)
    }
    return this._spawnStandalone(task, resources)
  }

  private async _spawnDocker(
    task: { id: string; image?: string; commands: string[] },
    resources: ResourceSpec,
  ): Promise<AgentHandle> {
    const image = task.image ?? 'ubuntu:22.04'
    const name = `claw-gvisor-${task.id}`

    const args = ['docker', 'run', '--runtime=runsc', '-d', '--name', name]

    if (resources.memory_mb) {
      args.push('--memory', `${resources.memory_mb}m`)
    }
    if (resources.cpu_cores) {
      args.push('--cpus', `${resources.cpu_cores}`)
    }
    if (!resources.network) {
      args.push('--network', 'none')
    }
    if (resources.writable_paths?.length) {
      for (const p of resources.writable_paths) {
        args.push('-v', `${p}:${p}`)
      }
    }

    args.push(image, 'sleep', 'infinity')

    const r = await spawnCmd(args)
    if (r.exit_code !== 0) {
      throw new Error(`gVisor docker run failed: ${r.stderr.trim()}`)
    }

    return {
      id: name,
      runtime: this.name,
      device_id: DEVICE_ID,
      started_at: Date.now(),
      resource_spec: resources,
    }
  }

  private async _spawnStandalone(
    task: { id: string; image?: string; commands: string[] },
    resources: ResourceSpec,
  ): Promise<AgentHandle> {
    const bundleDir = join(BUNDLE_BASE, task.id)
    const rootfsDir = join(bundleDir, 'rootfs')

    mkdirSync(rootfsDir, { recursive: true })

    // Minimal rootfs: just /bin and /tmp so sh is reachable via exec
    const dirs = ['bin', 'lib', 'lib64', 'usr', 'tmp', 'proc', 'dev', 'sys', 'etc']
    for (const d of dirs) {
      mkdirSync(join(rootfsDir, d), { recursive: true })
    }

    const config = buildOciConfig(resources)
    writeFileSync(join(bundleDir, 'config.json'), JSON.stringify(config, null, 2))

    const r = await spawnCmd(['runsc', 'create', '--bundle', bundleDir, task.id])
    if (r.exit_code !== 0) {
      throw new Error(`runsc create failed: ${r.stderr.trim()}`)
    }

    await spawnCmd(['runsc', 'start', task.id])

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
    const mode = await this.resolveMode()

    let execArgs: string[]
    if (mode === 'docker') {
      execArgs = ['docker', 'exec', handle.id, 'sh', '-c', cmd]
    } else {
      execArgs = ['runsc', 'exec', handle.id, 'sh', '-c', cmd]
    }

    let r: { stdout: string; stderr: string; exit_code: number }
    let oom_killed = false

    try {
      r = await spawnCmd(execArgs, timeout_ms)
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

    // check OOM via docker inspect if docker mode and non-zero exit
    if (r.exit_code !== 0 && mode === 'docker') {
      try {
        const inspect = await spawnCmd([
          'docker', 'inspect', '--format', '{{.State.OOMKilled}}', handle.id,
        ])
        oom_killed = inspect.stdout.trim() === 'true'
      } catch {
        // best-effort
      }
    }

    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exit_code: r.exit_code,
      duration_ms: Date.now() - start,
      oom_killed,
    }
  }

  async cleanup(handle: AgentHandle): Promise<void> {
    const mode = await this.resolveMode()

    if (mode === 'docker') {
      await spawnCmd(['docker', 'rm', '-f', '-v', handle.id])
    } else {
      // standalone: kill + delete sandbox, then remove bundle dir
      await spawnCmd(['runsc', 'kill', handle.id, 'KILL'])
      await spawnCmd(['runsc', 'delete', '-force', handle.id])
      const bundleDir = join(BUNDLE_BASE, handle.id)
      if (existsSync(bundleDir)) {
        rmSync(bundleDir, { recursive: true, force: true })
      }
    }
  }

  async getMetrics(): Promise<RuntimeMetrics> {
    const mode = await this.resolveMode()

    let active_agents = 0
    let cpu_usage_pct = 0
    let memory_used_mb = 0

    if (mode === 'docker') {
      const list = await spawnCmd([
        'docker', 'ps', '--filter', 'name=claw-gvisor-', '--format', '{{.ID}}',
      ])
      const ids = list.stdout.trim().split('\n').filter(Boolean)
      active_agents = ids.length

      if (ids.length > 0) {
        const stats = await spawnCmd([
          'docker', 'stats', '--no-stream', '--format',
          '{{.CPUPerc}}\t{{.MemUsage}}',
          ...ids,
        ])

        for (const line of stats.stdout.trim().split('\n').filter(Boolean)) {
          const [cpuStr, memStr] = line.split('\t')
          cpu_usage_pct += parseFloat(cpuStr?.replace('%', '') ?? '0') || 0
          const memMatch = memStr?.match(/^([\d.]+)(\w+)/)
          if (memMatch) {
            const val = parseFloat(memMatch[1])
            const unit = memMatch[2].toLowerCase()
            if (unit.startsWith('g')) memory_used_mb += val * 1024
            else if (unit.startsWith('m')) memory_used_mb += val
            else if (unit.startsWith('k')) memory_used_mb += val / 1024
          }
        }
      }
    } else if (mode === 'standalone') {
      // runsc list shows active sandboxes
      try {
        const list = await spawnCmd(['runsc', 'list', '--format', 'json'])
        if (list.exit_code === 0) {
          const parsed = JSON.parse(list.stdout || '[]') as Array<{ id: string; status: string }>
          active_agents = parsed.filter(s => s.status === 'running').length
        }
      } catch {
        // best-effort
      }
    }

    return {
      runtime: this.name,
      active_agents,
      max_agents: parseInt(process.env.MAX_AGENTS ?? '10'),
      cpu_usage_pct,
      memory_used_mb,
    }
  }
}
