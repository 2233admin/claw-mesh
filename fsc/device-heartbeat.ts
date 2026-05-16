/**
 * Device Heartbeat Module
 *
 * Responsibilities:
 *  - Collect full DeviceCapability on startup (including NetBird/WireGuard IPs)
 *  - Register device in Redis (fsc:device:{id} hash + fsc:devices set)
 *  - Every 30 s: lightweight collectHeartbeatMetrics → update Redis + publish to fsc:heartbeats
 *  - Graceful stop via stopDeviceHeartbeat()
 */

import Redis from 'ioredis'
import { collectDeviceCapability, collectHeartbeatMetrics } from '../packages/core/src/metrics/collector'
import type { DeviceCapability } from '../packages/core/src/types/device'
import { REDIS_KEYS } from '../packages/core/src/types/device'

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _heartbeatTimer: ReturnType<typeof setInterval> | null = null
let _cachedCapability: DeviceCapability | null = null

// ---------------------------------------------------------------------------
// Network helpers (Bun.spawn, no child_process)
// ---------------------------------------------------------------------------

async function runCmd(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    return text.trim()
  } catch {
    return ''
  }
}

/**
 * Extract the first IPv4 address from `ip addr show <iface>` output.
 * Handles both "inet 100.80.x.x/16" and similar formats.
 */
function parseInetAddr(output: string): string | undefined {
  const match = output.match(/inet\s+([\d.]+)\//)
  return match?.[1]
}

async function detectNetbirdIp(): Promise<string | undefined> {
  // Prefer `netbird status` JSON (newer NetBird versions)
  const statusOut = await runCmd(['netbird', 'status', '--json'])
  if (statusOut) {
    try {
      const parsed = JSON.parse(statusOut) as Record<string, unknown>
      // netbird status --json: { "netbirdIp": "100.80.x.x/16", ... }
      const raw = parsed['netbirdIp'] ?? parsed['ip']
      if (typeof raw === 'string') {
        // strip CIDR if present
        return raw.split('/')[0]
      }
    } catch {
      // fall through to interface check
    }
  }

  // Fallback: read wt0 interface address
  const addrOut = await runCmd(['ip', 'addr', 'show', 'wt0'])
  return parseInetAddr(addrOut)
}

async function detectWireguardIp(): Promise<string | undefined> {
  const addrOut = await runCmd(['ip', 'addr', 'show', 'wg0'])
  return parseInetAddr(addrOut)
}

// ---------------------------------------------------------------------------
// Startup: full capability collection
// ---------------------------------------------------------------------------

/**
 * Collect full DeviceCapability and attach mesh IPs detected from system
 * interfaces, returning the enriched object.
 */
async function buildFullCapability(deviceId: string): Promise<DeviceCapability> {
  const [capability, netbirdIp, wireguardIp] = await Promise.all([
    collectDeviceCapability(deviceId),
    detectNetbirdIp(),
    detectWireguardIp(),
  ])

  return {
    ...capability,
    netbird_ip: netbirdIp,
    wireguard_ip: wireguardIp,
  }
}

// ---------------------------------------------------------------------------
// Redis registration
// ---------------------------------------------------------------------------

/**
 * Store full DeviceCapability as a JSON blob in the device hash and add
 * deviceId to the device set. TTL is set on the hash key so stale nodes
 * expire automatically if heartbeats stop (24h window).
 */
async function registerDevice(redis: Redis, capability: DeviceCapability): Promise<void> {
  const key = REDIS_KEYS.device(capability.device_id)

  await redis.hset(key, 'capability', JSON.stringify(capability))
  await redis.expire(key, 86400) // 24 h TTL; refreshed each heartbeat

  await redis.sadd(REDIS_KEYS.deviceSet, capability.device_id)
}

// ---------------------------------------------------------------------------
// Periodic heartbeat update
// ---------------------------------------------------------------------------

async function sendHeartbeat(
  redis: Redis,
  deviceId: string,
  getActiveTasks: () => number,
): Promise<void> {
  const activeTasks = getActiveTasks()
  const metrics = await collectHeartbeatMetrics(activeTasks)
  const now = Date.now()

  const key = REDIS_KEYS.device(deviceId)

  // Update lightweight fields in the device hash
  await redis.hset(key,
    'memory_available_mb', String(metrics.memory_total_mb - metrics.memory_used_mb),
    'memory_used_mb',      String(metrics.memory_used_mb),
    'memory_total_mb',     String(metrics.memory_total_mb),
    'cpu_usage_pct',       String(metrics.cpu_usage_pct),
    'disk_used_pct',       String(metrics.disk_used_pct),
    'active_tasks',        String(activeTasks),
    'last_heartbeat',      String(now),
  )
  // Refresh TTL so active devices never expire
  await redis.expire(key, 86400)

  // Publish heartbeat event to the shared stream
  // Matches the existing format used by fsc-worker-daemon + adds new fields
  const streamFields: Record<string, string> = {
    agent:               deviceId,
    active_tasks:        String(activeTasks),
    cpu_usage_pct:       String(metrics.cpu_usage_pct),
    memory_used_mb:      String(metrics.memory_used_mb),
    memory_total_mb:     String(metrics.memory_total_mb),
    memory_available_mb: String(metrics.memory_total_mb - metrics.memory_used_mb),
    disk_used_pct:       String(metrics.disk_used_pct),
    timestamp:           String(now),
  }

  if (metrics.gpu_utilization_pct !== undefined) {
    streamFields['gpu_utilization_pct'] = String(metrics.gpu_utilization_pct)
  }
  if (metrics.gpu_vram_used_mb !== undefined) {
    streamFields['gpu_vram_used_mb'] = String(metrics.gpu_vram_used_mb)
  }
  if (metrics.gpu_temperature_c !== undefined) {
    streamFields['gpu_temperature_c'] = String(metrics.gpu_temperature_c)
  }
  if (metrics.battery_pct !== undefined) {
    streamFields['battery_pct'] = String(metrics.battery_pct)
  }

  // Include mesh IPs from cached capability if available
  if (_cachedCapability?.netbird_ip) {
    streamFields['netbird_ip'] = _cachedCapability.netbird_ip
  }
  if (_cachedCapability?.wireguard_ip) {
    streamFields['wireguard_ip'] = _cachedCapability.wireguard_ip
  }

  const flatArgs: string[] = []
  for (const [k, v] of Object.entries(streamFields)) {
    flatArgs.push(k, v)
  }
  await redis.xadd('fsc:heartbeats', '*', ...flatArgs)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the device heartbeat loop.
 *
 * 1. Collects full DeviceCapability (including NetBird/WireGuard IPs).
 * 2. Registers the device in Redis.
 * 3. Begins a 30-second heartbeat interval.
 *
 * Safe to call once; calling again while running is a no-op.
 */
export async function startDeviceHeartbeat(
  redis: Redis,
  deviceId: string,
  getActiveTasks: () => number,
): Promise<void> {
  if (_heartbeatTimer !== null) return

  // Step 1: full capability collection (includes NetBird + WireGuard IPs)
  const capability = await buildFullCapability(deviceId)
  _cachedCapability = capability

  // Step 2: register in Redis
  await registerDevice(redis, capability)

  // Step 3: start periodic lightweight heartbeat
  _heartbeatTimer = setInterval(async () => {
    try {
      await sendHeartbeat(redis, deviceId, getActiveTasks)
    } catch (err) {
      console.error('[device-heartbeat] heartbeat error:', err)
    }
  }, 30_000)

  // Send an immediate heartbeat right after registration
  try {
    await sendHeartbeat(redis, deviceId, getActiveTasks)
  } catch (err) {
    console.error('[device-heartbeat] initial heartbeat error:', err)
  }
}

/**
 * Stop the heartbeat interval. Safe to call multiple times.
 */
export function stopDeviceHeartbeat(): void {
  if (_heartbeatTimer !== null) {
    clearInterval(_heartbeatTimer)
    _heartbeatTimer = null
  }
}

/**
 * Return the locally cached DeviceCapability collected at startup.
 * Throws if startDeviceHeartbeat has not been called yet.
 */
export async function getLocalCapability(): Promise<DeviceCapability> {
  if (_cachedCapability === null) {
    throw new Error('getLocalCapability() called before startDeviceHeartbeat()')
  }
  return _cachedCapability
}
