/**
 * Capability-Aware Scheduler v2
 *
 * Extends v1.3 affinity+idle scheduling with hardware capability matching.
 * Hard constraints eliminate candidates; soft constraints and weighted scoring
 * determine the winner among the survivors.
 *
 * Scoring breakdown (weights must sum to 1.0, see DEFAULT_WEIGHTS):
 *   idle_capacity   0.40 — prefer nodes with room to spare
 *   hardware_fit    0.25 — GPU match + memory headroom
 *   network_quality 0.15 — low latency + wired bonus
 *   trust_score     0.15 — from TrustFactor system (0–100)
 *   affinity        0.05 — module-level task affinity from v1.3
 */

import type { DeviceCapability, TaskRequirement, SchedulerWeights } from '../types/device'
import { DEFAULT_WEIGHTS } from '../types/device'

// ─── Trust level ordering ───

const TRUST_ORDER: Record<string, number> = {
  trusted: 2,
  verified: 1,
  community: 0,
}

// ─── Hard constraint filter ───

/**
 * Filter devices to those that satisfy every hard constraint in the task.
 * Returns only devices eligible for scoring.
 *
 * Hard constraints checked (in order):
 *  1. required_platforms — device.platform must be in the list
 *  2. required_gpu       — device must have at least one GPU
 *  3. min_memory_mb      — device.memory_available_mb >= requirement
 *  4. min_vram_mb        — sum of all GPU vram_mb >= requirement
 *  5. required_runtime   — runtime must be in device.runtimes
 *  6. required_trust     — device trust_level >= minimum in trusted > verified > community order
 *  7. min_disk_gb        — device.disk_available_gb >= requirement
 *  8. required_tags      — all required tags must appear in device.tags
 *  9. ephemeral penalty  — ephemeral devices excluded when estimated_duration_s > 300 or prefer_stable
 */
export function filterDevices(
  devices: DeviceCapability[],
  task: TaskRequirement,
): DeviceCapability[] {
  return devices.filter((d) => {
    // Must be able to run tasks
    if (!d.can_run_tasks) return false

    // Platform constraint
    if (task.required_platforms && task.required_platforms.length > 0) {
      if (!task.required_platforms.includes(d.platform)) return false
    }

    // GPU required
    if (task.required_gpu && d.gpus.length === 0) return false

    // Minimum available memory
    if (task.min_memory_mb !== undefined && d.memory_available_mb < task.min_memory_mb) return false

    // Minimum VRAM (sum across all GPUs)
    if (task.min_vram_mb !== undefined) {
      const totalVram = d.gpus.reduce((sum, g) => sum + g.vram_mb, 0)
      if (totalVram < task.min_vram_mb) return false
    }

    // Required runtime
    if (task.required_runtime && !d.runtimes.includes(task.required_runtime)) return false

    // Minimum trust level
    if (task.required_trust !== undefined) {
      const deviceRank = TRUST_ORDER[d.trust_level] ?? 0
      const requiredRank = TRUST_ORDER[task.required_trust] ?? 0
      if (deviceRank < requiredRank) return false
    }

    // Minimum disk space
    if (task.min_disk_gb !== undefined && d.disk_available_gb < task.min_disk_gb) return false

    // Required tags
    if (task.required_tags && task.required_tags.length > 0) {
      if (!task.required_tags.every((t) => d.tags.includes(t))) return false
    }

    // Ephemeral exclusion: skip transient devices for long-running or stability-sensitive tasks
    if (d.ephemeral) {
      if (task.prefer_stable) return false
      if (task.estimated_duration_s !== undefined && task.estimated_duration_s > 300) return false
    }

    return true
  })
}

// ─── Component scorers (pure, 0–100 each) ───

/**
 * Idle capacity score.
 * Full slots free = 100; no slots free = 0.
 * activeTasks is supplied externally (from heartbeat or scheduler pending map).
 */
function scoreIdleCapacity(device: DeviceCapability, activeTasks: number): number {
  if (device.max_concurrent_tasks <= 0) return 0
  const idle = Math.max(0, device.max_concurrent_tasks - activeTasks)
  return (idle / device.max_concurrent_tasks) * 100
}

/**
 * Hardware fit score (0–100).
 *
 * GPU component (0–50):
 *   - Task wants GPU and device has one: +50
 *   - Task doesn't want GPU but device has one: +25 (bonus resource)
 *   - No GPU either way: 0
 *
 * Memory headroom component (0–50):
 *   - Score = min(50, available_mb / estimated_mb * 50)
 *   - Falls back to 512 MB estimate when task doesn't specify
 */
function scoreHardwareFit(device: DeviceCapability, task: TaskRequirement): number {
  // GPU component
  const hasGpu = device.gpus.length > 0
  let gpuScore = 0
  if (task.prefer_gpu || task.required_gpu) {
    gpuScore = hasGpu ? 50 : 0
  } else {
    gpuScore = hasGpu ? 25 : 0
  }

  // Memory headroom component
  const estimatedMb = task.estimated_memory_mb ?? 512
  const memScore = Math.min(50, (device.memory_available_mb / estimatedMb) * 50)

  return gpuScore + memScore
}

/**
 * Network quality score (0–100).
 *
 * Latency contribution (0–100):
 *   - latency 0ms → 100; every 5ms shaves 1 point; capped at 0
 *
 * Network type bonus:
 *   - wired: +0 (already reflected in low latency typically)
 *   - wifi:  −5
 *   - cellular: −15
 *
 * Final value clamped to [0, 100].
 */
function scoreNetworkQuality(device: DeviceCapability): number {
  const latencyScore = Math.max(0, 100 - (device.latency_to_relay_ms ?? 0) / 5)

  const networkBonus: Record<string, number> = {
    wired: 0,
    wifi: -5,
    cellular: -15,
  }
  const typeAdj = networkBonus[device.network_type] ?? 0

  return Math.max(0, Math.min(100, latencyScore + typeAdj))
}

// ─── Soft constraint bonuses ───

/**
 * Soft constraint bonus points added on top of the weighted score.
 * These are not normalised — they are flat additions capped to prevent gaming.
 *
 *   prefer_gpu + has GPU:            +10
 *   prefer_low_latency + <50ms:      +10
 *   prefer_local_model + model loaded: +15
 */
function softBonuses(device: DeviceCapability, task: TaskRequirement): number {
  let bonus = 0

  if (task.prefer_gpu && device.gpus.length > 0) {
    bonus += 10
  }

  if (task.prefer_low_latency && (device.latency_to_relay_ms ?? Infinity) < 50) {
    bonus += 10
  }

  if (task.prefer_local_model && device.inference_models.includes(task.prefer_local_model)) {
    bonus += 15
  }

  return bonus
}

// ─── Main scorer ───

/**
 * Score a single device against a task and its trust/affinity signals.
 *
 * Returns null when any hard constraint is violated (caller should use
 * filterDevices first for batch filtering; this null path handles
 * single-device checks without re-running the full filter pass).
 *
 * @param device        — full capability descriptor
 * @param task          — placement requirements
 * @param trustScore    — 0–100 from TrustFactor.getScore()
 * @param affinityWeight — 0–1 normalised affinity from v1.3 affinity system
 * @param weights       — scoring dimension weights (must sum to 1.0)
 * @param activeTasks   — tasks currently running on this device (default 0)
 * @returns weighted score (roughly 0–135 including soft bonuses), or null
 */
export function scoreDevice(
  device: DeviceCapability,
  task: TaskRequirement,
  trustScore: number,
  affinityWeight: number,
  weights: SchedulerWeights = DEFAULT_WEIGHTS,
  activeTasks = 0,
): number | null {
  // Re-check hard constraints for single-device usage
  const [passed] = filterDevices([device], task)
  if (!passed) return null

  const idle = scoreIdleCapacity(device, activeTasks)
  const hwFit = scoreHardwareFit(device, task)
  const netQ = scoreNetworkQuality(device)
  // trustScore already 0–100; affinityWeight 0–1 → scale to 0–100
  const affinity = Math.min(100, Math.max(0, affinityWeight * 100))

  const weighted =
    idle * weights.idle_capacity +
    hwFit * weights.hardware_fit +
    netQ * weights.network_quality +
    trustScore * weights.trust_score +
    affinity * weights.affinity

  return weighted + softBonuses(device, task)
}

// ─── Device picker ───

/**
 * Select the best device from a candidate pool for a given task.
 *
 * Steps:
 *  1. Filter by hard constraints (filterDevices)
 *  2. Fetch trust scores and affinity weights in parallel
 *  3. Score each surviving candidate
 *  4. Return the highest-scoring device, or null if pool is empty
 *
 * @param devices        — all known devices (pre-filtered or full registry)
 * @param task           — placement requirements
 * @param getTrustScore  — async lookup returning 0–100 trust score by device_id
 * @param getAffinity    — async lookup returning 0–1 normalised affinity by device_id
 * @param weights        — optional custom scoring weights
 */
export async function pickDevice(
  devices: DeviceCapability[],
  task: TaskRequirement,
  getTrustScore: (deviceId: string) => Promise<number>,
  getAffinity: (deviceId: string) => Promise<number>,
  weights: SchedulerWeights = DEFAULT_WEIGHTS,
): Promise<DeviceCapability | null> {
  const candidates = filterDevices(devices, task)
  if (candidates.length === 0) return null

  // Fetch trust scores and affinities in parallel across all candidates
  const [trustScores, affinities] = await Promise.all([
    Promise.all(candidates.map((d) => getTrustScore(d.device_id))),
    Promise.all(candidates.map((d) => getAffinity(d.device_id))),
  ])

  let best: DeviceCapability | null = null
  let bestScore = -Infinity

  for (let i = 0; i < candidates.length; i++) {
    const device = candidates[i]
    const score = scoreDevice(device, task, trustScores[i], affinities[i], weights)
    if (score !== null && score > bestScore) {
      best = device
      bestScore = score
    }
  }

  return best
}
