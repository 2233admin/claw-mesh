/**
 * Hierarchical Scheduler — 3-tier topology for 10K+ device scaling
 *
 * Problem: flat pickDevice() does O(N) filter + 2N Redis lookups per task.
 * At N=10K, 100 tasks/sec = 1M Redis ops/sec. Central 2G node dies.
 *
 * Solution: 3-tier hierarchy
 *   Tier 1: Global Coordinator (this node)
 *     - Holds region-level capacity summaries, not per-device state
 *     - Routes tasks to best region in O(R) where R ~ 10-50 regions
 *
 *   Tier 2: Regional Scheduler (one per region)
 *     - Manages ~200-500 devices in its region
 *     - Runs the existing pickDevice() locally (O(k) where k ≤ 500)
 *     - Reports capacity summary upstream every 5s
 *
 *   Tier 3: Device Agents (10K+ nodes)
 *     - Report heartbeat to regional scheduler only
 *     - Execute assigned tasks
 *
 * Math: scheduling overhead drops from O(N) to O(R + k) where R*k = N.
 * For N=10K, R=50, k=200: O(250) vs O(10,000) per task.
 *
 * Consistent hashing: models map to a "home set" of regions for cache locality.
 */

import type { DeviceCapability, TaskRequirement, SchedulerWeights } from '../types/device'
import { DEFAULT_WEIGHTS } from '../types/device'
import { filterDevices, scoreDevice, pickDevice } from './capability-scheduler'

// ─── Region types ───

export interface RegionSummary {
  region_id: string
  /** Human-readable label (e.g., "cn-central", "us-sv", "jp-tokyo") */
  label: string
  /** Number of online devices in this region */
  device_count: number
  /** Number of idle task slots across all devices */
  available_slots: number
  /** Total VRAM across all GPUs in region (MB) */
  total_vram_mb: number
  /** Available VRAM not occupied by running tasks (MB) */
  available_vram_mb: number
  /** Total memory across all devices (MB) */
  total_memory_mb: number
  /** Models currently loaded in this region */
  loaded_models: string[]
  /** Average latency to relay (ms) */
  avg_latency_ms: number
  /** Highest trust level available in region */
  max_trust_level: 'trusted' | 'verified' | 'community'
  /** Platforms available in this region */
  platforms: Set<string> | string[]
  /** Runtimes available in this region */
  runtimes: Set<string> | string[]
  /** Last summary update (unix ms) */
  last_updated: number
  /** Regional scheduler endpoint */
  endpoint: string
}

export interface RegionAssignment {
  region_id: string
  score: number
  reason: string
}

// ─── Consistent hash ring for model affinity ───

export class ModelHashRing {
  private ring: Array<{ hash: number; region_id: string }> = []
  private vnodes: number

  constructor(vnodes = 150) {
    this.vnodes = vnodes
  }

  /** Add a region to the hash ring with virtual nodes (idempotent). */
  addRegion(region_id: string): void {
    this.removeRegion(region_id)
    for (let i = 0; i < this.vnodes; i++) {
      const hash = fnv1a(`${region_id}:${i}`)
      this.ring.push({ hash, region_id })
    }
    this.ring.sort((a, b) => a.hash - b.hash)
  }

  /** Remove a region from the hash ring. */
  removeRegion(region_id: string): void {
    this.ring = this.ring.filter(n => n.region_id !== region_id)
  }

  /** Find the home region for a model (consistent hashing lookup). */
  lookup(model: string): string | null {
    if (this.ring.length === 0) return null
    const h = fnv1a(model)
    // Binary search for first node with hash >= h
    let lo = 0, hi = this.ring.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.ring[mid].hash < h) lo = mid + 1
      else hi = mid
    }
    // Wrap around
    const idx = lo < this.ring.length ? lo : 0
    return this.ring[idx].region_id
  }

  /** Get N closest regions for redundancy. */
  lookupN(model: string, n: number): string[] {
    if (this.ring.length === 0) return []
    const h = fnv1a(model)
    let lo = 0, hi = this.ring.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.ring[mid].hash < h) lo = mid + 1
      else hi = mid
    }

    const seen = new Set<string>()
    const result: string[] = []
    for (let i = 0; i < this.ring.length && result.length < n; i++) {
      const idx = (lo + i) % this.ring.length
      const rid = this.ring[idx].region_id
      if (!seen.has(rid)) {
        seen.add(rid)
        result.push(rid)
      }
    }
    return result
  }
}

// FNV-1a hash (32-bit, fast, good distribution)
function fnv1a(str: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

// ─── Region scoring ───

const TRUST_RANK: Record<string, number> = {
  trusted: 2,
  verified: 1,
  community: 0,
}

/**
 * Score a region for a task based on capacity summary.
 * Lightweight — uses aggregate stats, not per-device state.
 */
function scoreRegion(region: RegionSummary, task: TaskRequirement): number | null {
  // Hard constraint checks on aggregates
  if (task.required_platforms && task.required_platforms.length > 0) {
    const plats = region.platforms instanceof Set ? region.platforms : new Set(region.platforms)
    if (!task.required_platforms.some(p => plats.has(p))) return null
  }

  if (task.required_gpu && region.total_vram_mb === 0) return null

  if (task.min_vram_mb !== undefined && region.available_vram_mb < task.min_vram_mb) return null

  if (task.required_runtime) {
    const rts = region.runtimes instanceof Set ? region.runtimes : new Set(region.runtimes)
    if (!rts.has(task.required_runtime)) return null
  }

  if (task.required_trust !== undefined) {
    const reqRank = TRUST_RANK[task.required_trust] ?? 0
    const regRank = TRUST_RANK[region.max_trust_level] ?? 0
    if (regRank < reqRank) return null
  }

  if (region.available_slots <= 0) return null

  // Scoring (0-100)
  const capacityScore = Math.min(100, (region.available_slots / Math.max(1, region.device_count)) * 100)
  const latencyScore = Math.max(0, 100 - (region.avg_latency_ms / 5))
  const modelAffinity = task.prefer_local_model && region.loaded_models.includes(task.prefer_local_model)
    ? 100 : 0

  return capacityScore * 0.5 + latencyScore * 0.3 + modelAffinity * 0.2
}

// ─── Hierarchical scheduler ───

/**
 * Global coordinator: picks the best region for a task.
 *
 * Uses region summaries (not per-device state) for O(R) routing.
 * The chosen region's scheduler then does local O(k) device selection.
 */
export function pickRegion(
  regions: RegionSummary[],
  task: TaskRequirement,
  modelRing?: ModelHashRing,
): RegionAssignment | null {
  // If model affinity exists, check hash ring first
  if (modelRing && task.prefer_local_model) {
    const homeRegions = modelRing.lookupN(task.prefer_local_model, 3)
    for (const rid of homeRegions) {
      const region = regions.find(r => r.region_id === rid)
      if (region) {
        const score = scoreRegion(region, task)
        if (score !== null && score > 30) {
          return { region_id: rid, score, reason: `model affinity (${task.prefer_local_model})` }
        }
      }
    }
  }

  // Fall back to scoring all regions
  let best: RegionAssignment | null = null

  for (const region of regions) {
    const score = scoreRegion(region, task)
    if (score === null) continue

    const reasons: string[] = []
    if (region.available_slots > region.device_count * 0.5) reasons.push('high capacity')
    if (region.avg_latency_ms < 50) reasons.push('low latency')
    if (task.prefer_local_model && region.loaded_models.includes(task.prefer_local_model)) {
      reasons.push('has model')
    }

    const assignment: RegionAssignment = {
      region_id: region.region_id,
      score,
      reason: reasons.join(', ') || region.label,
    }

    if (!best || score > best.score) {
      best = assignment
    }
  }

  return best
}

/**
 * Build a region summary from a set of devices.
 * Called by regional schedulers to report upstream.
 */
export function buildRegionSummary(
  region_id: string,
  label: string,
  endpoint: string,
  devices: DeviceCapability[],
  activeTaskCounts: Map<string, number>,
  activeVramMb?: Map<string, number>,
): RegionSummary {
  const online = devices.filter(d => d.can_run_tasks)
  const platforms = new Set<string>()
  const runtimes = new Set<string>()
  const models = new Set<string>()
  let totalVram = 0
  let availVram = 0
  let totalMem = 0
  let availSlots = 0
  let latencySum = 0
  let latencyCount = 0
  let maxTrust: 'trusted' | 'verified' | 'community' = 'community'

  for (const d of online) {
    platforms.add(d.platform)
    for (const r of d.runtimes) runtimes.add(r)
    for (const m of d.inference_models) models.add(m)

    const vram = d.gpus.reduce((sum, g) => sum + g.vram_mb, 0)
    totalVram += vram
    const usedVram = activeVramMb?.get(d.device_id) ?? 0
    availVram += Math.max(0, vram - usedVram)

    totalMem += d.memory_total_mb

    const active = activeTaskCounts.get(d.device_id) ?? 0
    availSlots += Math.max(0, d.max_concurrent_tasks - active)

    if (d.latency_to_relay_ms !== undefined) {
      latencySum += d.latency_to_relay_ms
      latencyCount++
    }

    const rank = TRUST_RANK[d.trust_level] ?? 0
    if (rank > (TRUST_RANK[maxTrust] ?? 0)) {
      maxTrust = d.trust_level
    }
  }

  return {
    region_id,
    label,
    device_count: online.length,
    available_slots: availSlots,
    total_vram_mb: totalVram,
    available_vram_mb: availVram,
    total_memory_mb: totalMem,
    loaded_models: Array.from(models),
    avg_latency_ms: latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0,
    max_trust_level: maxTrust,
    platforms,
    runtimes,
    last_updated: Date.now(),
    endpoint,
  }
}

/**
 * Full hierarchical routing: pick region, then pick device within region.
 *
 * This is the top-level entry point replacing flat pickDevice() at scale.
 * For small clusters (<100 devices), falls back to flat pickDevice().
 */
export async function hierarchicalPick(
  regions: RegionSummary[],
  /** Map from region_id to devices in that region */
  regionDevices: Map<string, DeviceCapability[]>,
  task: TaskRequirement,
  getTrustScore: (deviceId: string) => Promise<number>,
  getAffinity: (deviceId: string) => Promise<number>,
  modelRing?: ModelHashRing,
  weights?: SchedulerWeights,
): Promise<{ region_id: string; device: DeviceCapability } | null> {
  // Step 1: Pick region (O(R))
  const regionPick = pickRegion(regions, task, modelRing)
  if (!regionPick) return null

  // Step 2: Pick device within region (O(k))
  const devices = regionDevices.get(regionPick.region_id)
  if (!devices || devices.length === 0) return null

  const device = await pickDevice(devices, task, getTrustScore, getAffinity, weights)
  if (!device) return null

  return { region_id: regionPick.region_id, device }
}
