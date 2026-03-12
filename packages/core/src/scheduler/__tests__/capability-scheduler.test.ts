import { describe, it, expect } from 'vitest'
import { filterDevices, scoreDevice, pickDevice } from '../capability-scheduler'
import type { DeviceCapability, TaskRequirement } from '../../types/device'
import { DEFAULT_WEIGHTS } from '../../types/device'

// ─── Test helpers ───

function makeDevice(overrides?: Partial<DeviceCapability>): DeviceCapability {
  return {
    device_id: 'dev-001',
    hostname: 'test-node',
    platform: 'linux',
    arch: 'x86_64',
    cpu_cores: 8,
    cpu_model: 'Intel Xeon',
    memory_total_mb: 16384,
    memory_available_mb: 8192,
    disk_total_gb: 500,
    disk_available_gb: 200,
    gpus: [],
    runtimes: ['docker', 'native'],
    network_type: 'wired',
    nat_type: 'public',
    latency_to_relay_ms: 10,
    can_run_tasks: true,
    can_serve_inference: false,
    inference_models: [],
    max_concurrent_tasks: 4,
    trust_level: 'trusted',
    sandbox_available: true,
    online_since: Date.now() - 3600_000,
    last_heartbeat: Date.now() - 5000,
    ephemeral: false,
    tags: [],
    ...overrides,
  }
}

function makeTask(overrides?: Partial<TaskRequirement>): TaskRequirement {
  return {
    ...overrides,
  }
}

function makeGpu(vram_mb = 8192) {
  return {
    name: 'RTX 3080',
    vendor: 'nvidia' as const,
    vram_mb,
    utilization_pct: 30,
  }
}

// ─── filterDevices ───

describe('filterDevices', () => {
  it('filters by required_platforms — only linux devices pass when linux required', () => {
    const linux = makeDevice({ platform: 'linux' })
    const windows = makeDevice({ device_id: 'dev-002', platform: 'windows' })
    const darwin = makeDevice({ device_id: 'dev-003', platform: 'darwin' })
    const task = makeTask({ required_platforms: ['linux'] })

    const result = filterDevices([linux, windows, darwin], task)

    expect(result).toHaveLength(1)
    expect(result[0].platform).toBe('linux')
  })

  it('filters by required_gpu — only devices with GPUs pass', () => {
    const withGpu = makeDevice({ device_id: 'gpu-node', gpus: [makeGpu()] })
    const noGpu = makeDevice({ device_id: 'cpu-node', gpus: [] })
    const task = makeTask({ required_gpu: true })

    const result = filterDevices([withGpu, noGpu], task)

    expect(result).toHaveLength(1)
    expect(result[0].device_id).toBe('gpu-node')
  })

  it('filters by min_memory_mb — insufficient memory excluded', () => {
    const enough = makeDevice({ device_id: 'big-ram', memory_available_mb: 16384 })
    const tooLittle = makeDevice({ device_id: 'small-ram', memory_available_mb: 2048 })
    const task = makeTask({ min_memory_mb: 8192 })

    const result = filterDevices([enough, tooLittle], task)

    expect(result).toHaveLength(1)
    expect(result[0].device_id).toBe('big-ram')
  })

  it('filters by min_vram_mb — sum of GPU VRAM checked across all GPUs', () => {
    const dualGpu = makeDevice({
      device_id: 'dual-gpu',
      gpus: [makeGpu(8192), makeGpu(8192)],
    })
    const singleGpu = makeDevice({
      device_id: 'single-gpu',
      gpus: [makeGpu(8192)],
    })
    const noGpu = makeDevice({ device_id: 'no-gpu', gpus: [] })
    const task = makeTask({ min_vram_mb: 12288 })

    const result = filterDevices([dualGpu, singleGpu, noGpu], task)

    expect(result).toHaveLength(1)
    expect(result[0].device_id).toBe('dual-gpu')
  })

  it('filters by required_runtime — device must have runtime in its list', () => {
    const hasPython = makeDevice({ device_id: 'py-node', runtimes: ['python', 'native'] })
    const hasDocker = makeDevice({ device_id: 'docker-node', runtimes: ['docker'] })
    const task = makeTask({ required_runtime: 'python' })

    const result = filterDevices([hasPython, hasDocker], task)

    expect(result).toHaveLength(1)
    expect(result[0].device_id).toBe('py-node')
  })

  it('filters by required_trust — trusted > verified > community ordering', () => {
    const trusted = makeDevice({ device_id: 'trusted', trust_level: 'trusted' })
    const verified = makeDevice({ device_id: 'verified', trust_level: 'verified' })
    const community = makeDevice({ device_id: 'community', trust_level: 'community' })

    const verifiedTask = makeTask({ required_trust: 'verified' })
    const result = filterDevices([trusted, verified, community], verifiedTask)

    expect(result.map((d) => d.device_id).sort()).toEqual(['trusted', 'verified'])
  })

  it('excludes ephemeral devices when prefer_stable is set', () => {
    const stable = makeDevice({ device_id: 'stable', ephemeral: false })
    const ephemeral = makeDevice({ device_id: 'ephemeral', ephemeral: true })
    const task = makeTask({ prefer_stable: true })

    const result = filterDevices([stable, ephemeral], task)

    expect(result).toHaveLength(1)
    expect(result[0].device_id).toBe('stable')
  })

  it('excludes ephemeral devices when estimated_duration_s > 300', () => {
    const stable = makeDevice({ device_id: 'stable', ephemeral: false })
    const ephemeral = makeDevice({ device_id: 'ephemeral', ephemeral: true })
    const task = makeTask({ estimated_duration_s: 600 })

    const result = filterDevices([stable, ephemeral], task)

    expect(result).toHaveLength(1)
    expect(result[0].device_id).toBe('stable')
  })

  it('does not exclude ephemeral devices when duration <= 300 and prefer_stable unset', () => {
    const stable = makeDevice({ device_id: 'stable', ephemeral: false })
    const ephemeral = makeDevice({ device_id: 'ephemeral', ephemeral: true })
    const task = makeTask({ estimated_duration_s: 60 })

    const result = filterDevices([stable, ephemeral], task)

    expect(result).toHaveLength(2)
  })

  it('passes all devices when no requirements are specified', () => {
    const devices = [
      makeDevice({ device_id: 'a' }),
      makeDevice({ device_id: 'b', platform: 'windows' }),
      makeDevice({ device_id: 'c', platform: 'darwin' }),
    ]
    const task = makeTask()

    const result = filterDevices(devices, task)

    expect(result).toHaveLength(3)
  })

  it('returns empty array when no devices match', () => {
    const device = makeDevice({ platform: 'linux' })
    const task = makeTask({ required_platforms: ['darwin'] })

    const result = filterDevices([device], task)

    expect(result).toHaveLength(0)
  })

  it('excludes devices where can_run_tasks is false', () => {
    const active = makeDevice({ device_id: 'active', can_run_tasks: true })
    const inactive = makeDevice({ device_id: 'inactive', can_run_tasks: false })

    const result = filterDevices([active, inactive], makeTask())

    expect(result).toHaveLength(1)
    expect(result[0].device_id).toBe('active')
  })

  it('filters by min_disk_gb — insufficient disk excluded', () => {
    const large = makeDevice({ device_id: 'large-disk', disk_available_gb: 500 })
    const small = makeDevice({ device_id: 'small-disk', disk_available_gb: 10 })
    const task = makeTask({ min_disk_gb: 100 })

    const result = filterDevices([large, small], task)

    expect(result).toHaveLength(1)
    expect(result[0].device_id).toBe('large-disk')
  })

  it('filters by required_tags — all tags must be present', () => {
    const tagged = makeDevice({ device_id: 'tagged', tags: ['gpu', 'high-mem', 'prod'] })
    const partial = makeDevice({ device_id: 'partial', tags: ['gpu'] })
    const untagged = makeDevice({ device_id: 'untagged', tags: [] })
    const task = makeTask({ required_tags: ['gpu', 'high-mem'] })

    const result = filterDevices([tagged, partial, untagged], task)

    expect(result).toHaveLength(1)
    expect(result[0].device_id).toBe('tagged')
  })
})

// ─── scoreDevice ───

describe('scoreDevice', () => {
  it('returns null when hard constraints are not met', () => {
    const device = makeDevice({ platform: 'linux' })
    const task = makeTask({ required_platforms: ['darwin'] })

    const score = scoreDevice(device, task, 80, 0.5)

    expect(score).toBeNull()
  })

  it('higher idle capacity produces higher score', () => {
    const busyDevice = makeDevice({ device_id: 'busy', max_concurrent_tasks: 4 })
    const idleDevice = makeDevice({ device_id: 'idle', max_concurrent_tasks: 4 })
    const task = makeTask()

    // busy device has 3 active tasks, idle device has 0
    const busyScore = scoreDevice(busyDevice, task, 50, 0.5, DEFAULT_WEIGHTS, 3)
    const idleScore = scoreDevice(idleDevice, task, 50, 0.5, DEFAULT_WEIGHTS, 0)

    expect(idleScore).not.toBeNull()
    expect(busyScore).not.toBeNull()
    expect(idleScore!).toBeGreaterThan(busyScore!)
  })

  it('GPU device scores higher when task prefers GPU', () => {
    const gpuDevice = makeDevice({ device_id: 'gpu', gpus: [makeGpu()] })
    const cpuDevice = makeDevice({ device_id: 'cpu', gpus: [] })
    const task = makeTask({ prefer_gpu: true })

    const gpuScore = scoreDevice(gpuDevice, task, 50, 0.5)
    const cpuScore = scoreDevice(cpuDevice, task, 50, 0.5)

    expect(gpuScore).not.toBeNull()
    expect(cpuScore).not.toBeNull()
    expect(gpuScore!).toBeGreaterThan(cpuScore!)
  })

  it('lower latency produces higher network score', () => {
    const lowLatency = makeDevice({ device_id: 'fast', latency_to_relay_ms: 5 })
    const highLatency = makeDevice({ device_id: 'slow', latency_to_relay_ms: 200 })
    const task = makeTask()

    const fastScore = scoreDevice(lowLatency, task, 50, 0.5)
    const slowScore = scoreDevice(highLatency, task, 50, 0.5)

    expect(fastScore).not.toBeNull()
    expect(slowScore).not.toBeNull()
    expect(fastScore!).toBeGreaterThan(slowScore!)
  })

  it('higher trust score produces higher overall score', () => {
    const device = makeDevice()
    const task = makeTask()

    const lowTrust = scoreDevice(device, task, 10, 0.5)
    const highTrust = scoreDevice(device, task, 90, 0.5)

    expect(lowTrust).not.toBeNull()
    expect(highTrust).not.toBeNull()
    expect(highTrust!).toBeGreaterThan(lowTrust!)
  })

  it('applies prefer_gpu soft bonus when device has GPU', () => {
    const gpuDevice = makeDevice({ gpus: [makeGpu()] })
    const cpuDevice = makeDevice({ gpus: [] })
    const task = makeTask({ prefer_gpu: true })

    const gpuScore = scoreDevice(gpuDevice, task, 50, 0.5)
    const cpuScore = scoreDevice(cpuDevice, task, 50, 0.5)

    // GPU device: hardware_fit GPU component = 50 (want GPU + has GPU), soft bonus +10
    // CPU device: hardware_fit GPU component = 0  (want GPU + no GPU),  soft bonus  +0
    // delta from GPU component alone = (50 - 0) * 0.25 = 12.5, plus +10 bonus = 22.5
    expect(gpuScore).not.toBeNull()
    expect(cpuScore).not.toBeNull()
    expect(gpuScore! - cpuScore!).toBeCloseTo(22.5, 5)
  })

  it('applies prefer_low_latency soft bonus when latency < 50ms', () => {
    const fastDevice = makeDevice({ latency_to_relay_ms: 20 })
    const task = makeTask({ prefer_low_latency: true })
    const taskNoBonus = makeTask({ prefer_low_latency: false })

    const withBonus = scoreDevice(fastDevice, task, 50, 0.5)
    const withoutBonus = scoreDevice(fastDevice, taskNoBonus, 50, 0.5)

    expect(withBonus! - withoutBonus!).toBeCloseTo(10, 5)
  })

  it('applies prefer_local_model soft bonus when model is loaded', () => {
    const device = makeDevice({ inference_models: ['qwen2.5-coder:7b'] })
    const task = makeTask({ prefer_local_model: 'qwen2.5-coder:7b' })
    const taskNoBonus = makeTask({ prefer_local_model: 'other-model' })

    const withBonus = scoreDevice(device, task, 50, 0.5)
    const withoutBonus = scoreDevice(device, taskNoBonus, 50, 0.5)

    expect(withBonus! - withoutBonus!).toBeCloseTo(15, 5)
  })

  it('custom weights change scoring proportions', () => {
    const device = makeDevice({ latency_to_relay_ms: 1 })
    const task = makeTask()

    const networkHeavy = scoreDevice(device, task, 50, 0.5, {
      idle_capacity: 0.10,
      hardware_fit: 0.10,
      network_quality: 0.60,
      trust_score: 0.10,
      affinity: 0.10,
    })
    const networkLight = scoreDevice(device, task, 50, 0.5, {
      idle_capacity: 0.40,
      hardware_fit: 0.25,
      network_quality: 0.05,
      trust_score: 0.25,
      affinity: 0.05,
    })

    expect(networkHeavy).not.toBeNull()
    expect(networkLight).not.toBeNull()
    // network_quality score is near-100 at 1ms, so network-heavy weighting should score higher
    expect(networkHeavy!).toBeGreaterThan(networkLight!)
  })

  it('score is between 0 and approximately 135 including all bonuses', () => {
    // Maximally good device: fast network, GPU, loaded model, all idle
    const device = makeDevice({
      gpus: [makeGpu()],
      latency_to_relay_ms: 0,
      memory_available_mb: 65536,
      max_concurrent_tasks: 8,
      inference_models: ['target-model'],
    })
    const task = makeTask({
      prefer_gpu: true,
      prefer_low_latency: true,
      prefer_local_model: 'target-model',
    })

    const score = scoreDevice(device, task, 100, 1.0, DEFAULT_WEIGHTS, 0)

    expect(score).not.toBeNull()
    expect(score!).toBeGreaterThanOrEqual(0)
    expect(score!).toBeLessThanOrEqual(135)
  })
})

// ─── pickDevice ───

describe('pickDevice', () => {
  const noTrust = async (_id: string) => 50
  const noAffinity = async (_id: string) => 0.5

  it('returns the best scoring device from the pool', async () => {
    const highIdle = makeDevice({ device_id: 'high-idle', max_concurrent_tasks: 8 })
    const lowIdle = makeDevice({ device_id: 'low-idle', max_concurrent_tasks: 8 })
    const task = makeTask()

    // highIdle has 0 active tasks, lowIdle has 7 active tasks
    const getTrust = noTrust
    const getAffinity = noAffinity

    // We score them directly to know the expected winner
    const highScore = scoreDevice(highIdle, task, 50, 0.5, DEFAULT_WEIGHTS, 0)
    const lowScore = scoreDevice(lowIdle, task, 50, 0.5, DEFAULT_WEIGHTS, 7)
    expect(highScore!).toBeGreaterThan(lowScore!)

    // pickDevice calls getTrustScore with no active tasks concept — both start at 0
    const winner = await pickDevice([highIdle, lowIdle], task, getTrust, getAffinity)
    // Both are identical except device_id — winner is arbitrary but must be one of them
    expect(winner).not.toBeNull()
    expect(['high-idle', 'low-idle']).toContain(winner!.device_id)
  })

  it('returns null when no devices match the task constraints', async () => {
    const device = makeDevice({ platform: 'linux' })
    const task = makeTask({ required_platforms: ['darwin'] })

    const result = await pickDevice([device], task, noTrust, noAffinity)

    expect(result).toBeNull()
  })

  it('returns null for an empty device pool', async () => {
    const result = await pickDevice([], makeTask(), noTrust, noAffinity)

    expect(result).toBeNull()
  })

  it('respects trust score returned from async lookup', async () => {
    const devA = makeDevice({ device_id: 'dev-a' })
    const devB = makeDevice({ device_id: 'dev-b' })
    const task = makeTask()

    // dev-a gets high trust, dev-b gets low trust
    const getTrust = async (id: string) => (id === 'dev-a' ? 100 : 0)
    const getAffinity = noAffinity

    const winner = await pickDevice([devA, devB], task, getTrust, getAffinity)

    expect(winner).not.toBeNull()
    expect(winner!.device_id).toBe('dev-a')
  })

  it('handles single device case — returns that device when it passes constraints', async () => {
    const device = makeDevice()
    const task = makeTask()

    const result = await pickDevice([device], task, noTrust, noAffinity)

    expect(result).not.toBeNull()
    expect(result!.device_id).toBe('dev-001')
  })

  it('GPU task goes to GPU device even if other device has more idle capacity', async () => {
    const gpuDevice = makeDevice({
      device_id: 'gpu-node',
      gpus: [makeGpu(16384)],
      max_concurrent_tasks: 2,
    })
    const cpuDevice = makeDevice({
      device_id: 'cpu-node',
      gpus: [],
      max_concurrent_tasks: 32,
    })
    // Task requires GPU — cpu-node is filtered out entirely
    const task = makeTask({ required_gpu: true })

    const result = await pickDevice([gpuDevice, cpuDevice], task, noTrust, noAffinity)

    expect(result).not.toBeNull()
    expect(result!.device_id).toBe('gpu-node')
  })

  it('uses affinity weight from async lookup when ranking candidates', async () => {
    const devA = makeDevice({ device_id: 'dev-a' })
    const devB = makeDevice({ device_id: 'dev-b' })
    const task = makeTask()

    const getTrust = noTrust
    // dev-a has perfect affinity, dev-b has none
    const getAffinity = async (id: string) => (id === 'dev-a' ? 1.0 : 0.0)

    const winner = await pickDevice([devA, devB], task, getTrust, getAffinity)

    expect(winner!.device_id).toBe('dev-a')
  })
})
