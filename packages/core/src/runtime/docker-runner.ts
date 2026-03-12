import type { TaskRunner, AgentHandle, ExecResult, ResourceSpec, RuntimeMetrics } from '../types/runtime'

const DEVICE_ID = process.env.DEVICE_ID ?? 'local'

async function spawnCmd(args: string[], timeout_ms?: number): Promise<{ stdout: string; stderr: string; exit_code: number }> {
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

export class DockerRunner implements TaskRunner {
  readonly name = 'docker'

  async isAvailable(): Promise<boolean> {
    try {
      const r = await spawnCmd(['docker', 'info'])
      return r.exit_code === 0
    } catch {
      return false
    }
  }

  async spawn(
    task: { id: string; image?: string; commands: string[] },
    resources: ResourceSpec
  ): Promise<AgentHandle> {
    const image = task.image ?? 'ubuntu:22.04'
    const name = `claw-${task.id}`

    const args = ['docker', 'run', '-d', '--name', name]

    if (resources.memory_mb) {
      args.push('--memory', `${resources.memory_mb}m`)
    }
    if (resources.cpu_cores) {
      args.push('--cpus', `${resources.cpu_cores}`)
    }
    if (resources.gpu) {
      args.push('--gpus', 'all')
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
      throw new Error(`docker run failed: ${r.stderr.trim()}`)
    }

    return {
      id: name,
      runtime: this.name,
      device_id: DEVICE_ID,
      started_at: Date.now(),
      resource_spec: resources,
    }
  }

  async run(handle: AgentHandle, cmd: string, timeout_s?: number): Promise<ExecResult> {
    const start = Date.now()
    const timeout_ms = timeout_s ? timeout_s * 1000 : undefined

    let r: { stdout: string; stderr: string; exit_code: number }
    let oom_killed = false

    try {
      r = await spawnCmd(['docker', 'exec', handle.id, 'sh', '-c', cmd], timeout_ms)
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

    // check OOM via docker inspect if non-zero exit
    if (r.exit_code !== 0) {
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
    // force-remove container (also removes anonymous volumes)
    await spawnCmd(['docker', 'rm', '-f', '-v', handle.id])
  }

  async getMetrics(): Promise<RuntimeMetrics> {
    // list claw-* containers
    const list = await spawnCmd([
      'docker', 'ps', '--filter', 'name=claw-', '--format', '{{.ID}}',
    ])
    const ids = list.stdout.trim().split('\n').filter(Boolean)

    let cpu_usage_pct = 0
    let memory_used_mb = 0

    if (ids.length > 0) {
      const stats = await spawnCmd([
        'docker', 'stats', '--no-stream', '--format',
        '{{.CPUPerc}}\t{{.MemUsage}}',
        ...ids,
      ])

      for (const line of stats.stdout.trim().split('\n').filter(Boolean)) {
        const [cpuStr, memStr] = line.split('\t')
        cpu_usage_pct += parseFloat(cpuStr?.replace('%', '') ?? '0') || 0
        // memStr looks like "123.4MiB / 512MiB"
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

    return {
      runtime: this.name,
      active_agents: ids.length,
      max_agents: parseInt(process.env.MAX_AGENTS ?? '10'),
      cpu_usage_pct,
      memory_used_mb,
    }
  }
}
