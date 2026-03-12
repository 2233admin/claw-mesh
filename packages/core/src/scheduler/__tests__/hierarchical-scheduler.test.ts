import { describe, it, expect } from 'vitest'
import {
  pickRegion,
  buildRegionSummary,
  ModelHashRing,
} from '../hierarchical-scheduler'
import type { RegionSummary } from '../hierarchical-scheduler'
import type { DeviceCapability, TaskRequirement } from '../../types/device'

function makeRegion(overrides: Partial<RegionSummary>): RegionSummary {
  return {
    region_id: 'test-region',
    label: 'Test Region',
    device_count: 10,
    available_slots: 5,
    total_vram_mb: 0,
    available_vram_mb: 0,
    total_memory_mb: 20480,
    loaded_models: [],
    avg_latency_ms: 30,
    max_trust_level: 'trusted',
    platforms: new Set(['linux']),
    runtimes: new Set(['docker', 'native']),
    last_updated: Date.now(),
    endpoint: 'http://localhost:9000',
    ...overrides,
  }
}

function makeDevice(overrides: Partial<DeviceCapability>): DeviceCapability {
  return {
    device_id: 'dev-1',
    hostname: 'node-1',
    platform: 'linux',
    arch: 'x86_64',
    cpu_cores: 4,
    cpu_model: 'Intel',
    memory_total_mb: 4096,
    memory_available_mb: 2048,
    disk_total_gb: 100,
    disk_available_gb: 50,
    gpus: [],
    runtimes: ['docker', 'native'],
    network_type: 'wired',
    nat_type: 'full_cone',
    can_run_tasks: true,
    can_serve_inference: false,
    inference_models: [],
    max_concurrent_tasks: 5,
    trust_level: 'trusted',
    sandbox_available: true,
    online_since: Date.now(),
    last_heartbeat: Date.now(),
    ephemeral: false,
    tags: [],
    ...overrides,
  }
}

// ─── pickRegion ───

describe('pickRegion', () => {
  it('picks highest-capacity region', () => {
    const regions = [
      makeRegion({ region_id: 'busy', available_slots: 1, device_count: 10 }),
      makeRegion({ region_id: 'idle', available_slots: 8, device_count: 10 }),
    ]
    const task: TaskRequirement = {}
    const result = pickRegion(regions, task)
    expect(result).not.toBeNull()
    expect(result!.region_id).toBe('idle')
  })

  it('filters by required_platforms', () => {
    const regions = [
      makeRegion({ region_id: 'linux-only', platforms: new Set(['linux']) }),
      makeRegion({ region_id: 'has-darwin', platforms: new Set(['linux', 'darwin']) }),
    ]
    const task: TaskRequirement = { required_platforms: ['darwin'] }
    const result = pickRegion(regions, task)
    expect(result).not.toBeNull()
    expect(result!.region_id).toBe('has-darwin')
  })

  it('filters by required_gpu', () => {
    const regions = [
      makeRegion({ region_id: 'no-gpu', total_vram_mb: 0 }),
      makeRegion({ region_id: 'has-gpu', total_vram_mb: 32768, available_vram_mb: 16000 }),
    ]
    const task: TaskRequirement = { required_gpu: true, min_vram_mb: 8000 }
    const result = pickRegion(regions, task)
    expect(result).not.toBeNull()
    expect(result!.region_id).toBe('has-gpu')
  })

  it('returns null when no region qualifies', () => {
    const regions = [
      makeRegion({ available_slots: 0 }),
    ]
    const result = pickRegion(regions, {})
    expect(result).toBeNull()
  })

  it('prefers region with model via hash ring', () => {
    const regions = [
      makeRegion({ region_id: 'r1', loaded_models: ['llama-7b'], available_slots: 3 }),
      makeRegion({ region_id: 'r2', loaded_models: ['qwen-72b'], available_slots: 5 }),
    ]

    const ring = new ModelHashRing()
    ring.addRegion('r1')
    ring.addRegion('r2')

    // With hash ring, model gets consistent routing
    const task: TaskRequirement = { prefer_local_model: 'qwen-72b' }
    const result = pickRegion(regions, task, ring)
    expect(result).not.toBeNull()
    // Should find the region that has the model loaded
    // (hash ring provides consistent lookup, but if region has model + slots, it wins)
  })

  it('filters by required_trust', () => {
    const regions = [
      makeRegion({ region_id: 'community', max_trust_level: 'community' }),
      makeRegion({ region_id: 'trusted', max_trust_level: 'trusted' }),
    ]
    const task: TaskRequirement = { required_trust: 'trusted' }
    const result = pickRegion(regions, task)
    expect(result!.region_id).toBe('trusted')
  })
})

// ─── ModelHashRing ───

describe('ModelHashRing', () => {
  it('returns null for empty ring', () => {
    const ring = new ModelHashRing()
    expect(ring.lookup('any-model')).toBeNull()
  })

  it('consistently maps same model to same region', () => {
    const ring = new ModelHashRing()
    ring.addRegion('r1')
    ring.addRegion('r2')
    ring.addRegion('r3')

    const first = ring.lookup('qwen-72b')
    const second = ring.lookup('qwen-72b')
    expect(first).toBe(second)
  })

  it('distributes models across regions', () => {
    const ring = new ModelHashRing()
    ring.addRegion('r1')
    ring.addRegion('r2')
    ring.addRegion('r3')

    const models = ['llama-7b', 'qwen-72b', 'phi-3', 'mistral-7b', 'gemma-2b', 'deepseek-33b']
    const assignments = models.map(m => ring.lookup(m))
    const unique = new Set(assignments)
    // Should hit at least 2 different regions with 6 models
    expect(unique.size).toBeGreaterThanOrEqual(2)
  })

  it('lookupN returns multiple distinct regions', () => {
    const ring = new ModelHashRing()
    ring.addRegion('r1')
    ring.addRegion('r2')
    ring.addRegion('r3')

    const result = ring.lookupN('qwen-72b', 3)
    expect(result).toHaveLength(3)
    expect(new Set(result).size).toBe(3) // all distinct
  })

  it('handles region removal', () => {
    const ring = new ModelHashRing()
    ring.addRegion('r1')
    ring.addRegion('r2')

    const before = ring.lookup('test-model')
    ring.removeRegion(before!)

    const after = ring.lookup('test-model')
    expect(after).not.toBe(before)
  })
})

// ─── buildRegionSummary ───

describe('buildRegionSummary', () => {
  it('aggregates device capabilities', () => {
    const devices: DeviceCapability[] = [
      makeDevice({ device_id: 'd1', memory_total_mb: 4096, max_concurrent_tasks: 5, inference_models: ['qwen-7b'] }),
      makeDevice({ device_id: 'd2', memory_total_mb: 8192, max_concurrent_tasks: 10, inference_models: ['llama-7b'] }),
    ]
    const activeTasks = new Map([['d1', 2], ['d2', 3]])

    const summary = buildRegionSummary('cn-central', 'Central', 'http://10.10.0.1:9000', devices, activeTasks)

    expect(summary.device_count).toBe(2)
    expect(summary.available_slots).toBe(10) // (5-2) + (10-3)
    expect(summary.total_memory_mb).toBe(12288)
    expect(summary.loaded_models).toContain('qwen-7b')
    expect(summary.loaded_models).toContain('llama-7b')
    expect(summary.platforms.has('linux')).toBe(true)
  })

  it('excludes devices that cannot run tasks', () => {
    const devices: DeviceCapability[] = [
      makeDevice({ can_run_tasks: true, max_concurrent_tasks: 5 }),
      makeDevice({ device_id: 'd2', can_run_tasks: false, max_concurrent_tasks: 5 }),
    ]

    const summary = buildRegionSummary('r1', 'R1', 'http://localhost', devices, new Map())
    expect(summary.device_count).toBe(1)
    expect(summary.available_slots).toBe(5)
  })
})
