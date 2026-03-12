/**
 * Cross-platform metrics collector for FSC mesh nodes.
 * Supports Linux, macOS, Windows. Uses Bun.spawn exclusively (no child_process).
 */

import type { DeviceCapability, GpuInfo, Platform, Arch, Runtime, NetworkType } from '../types/device'

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface HeartbeatMetrics {
  cpu_usage_pct: number
  memory_used_mb: number
  memory_total_mb: number
  disk_used_pct: number
  gpu_utilization_pct?: number
  gpu_vram_used_mb?: number
  gpu_temperature_c?: number
  active_tasks: number
  battery_pct?: number
}

// ---------------------------------------------------------------------------
// Internal: shell helpers
// ---------------------------------------------------------------------------

async function run(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    return text.trim()
  } catch {
    return ''
  }
}

async function fileText(path: string): Promise<string> {
  try {
    return await Bun.file(path).text()
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------

// State for Linux delta-based CPU calculation
let _prevCpuIdle = 0
let _prevCpuTotal = 0

function parseProcStat(content: string): { idle: number; total: number } {
  const line = content.split('\n')[0]
  const parts = line.split(/\s+/).slice(1).map(Number)
  const idle = parts[3] ?? 0
  const total = parts.reduce((a, b) => a + b, 0)
  return { idle, total }
}

async function cpuUsageLinux(): Promise<number> {
  const content = await fileText('/proc/stat')
  if (!content) return 0
  const { idle, total } = parseProcStat(content)
  if (_prevCpuTotal === 0) {
    _prevCpuIdle = idle
    _prevCpuTotal = total
    // first call: wait 200ms and re-sample for a meaningful delta
    await Bun.sleep(200)
    const content2 = await fileText('/proc/stat')
    if (!content2) return 0
    const s2 = parseProcStat(content2)
    const idleDelta = s2.idle - idle
    const totalDelta = s2.total - total
    _prevCpuIdle = s2.idle
    _prevCpuTotal = s2.total
    return totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0
  }
  const idleDelta = idle - _prevCpuIdle
  const totalDelta = total - _prevCpuTotal
  _prevCpuIdle = idle
  _prevCpuTotal = total
  return totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0
}

async function cpuUsageMacOS(): Promise<number> {
  // `top -l 2 -n 0` gives two samples; take the second for accuracy
  const out = await run(['top', '-l', '2', '-n', '0', '-s', '1'])
  const lines = out.split('\n')
  // Find last "CPU usage:" line
  let cpuLine = ''
  for (const l of lines) {
    if (l.startsWith('CPU usage:')) cpuLine = l
  }
  if (!cpuLine) return 0
  // "CPU usage: 12.34% user, 5.67% sys, 82.0% idle"
  const idleMatch = cpuLine.match(/(\d+\.?\d*)\s*%\s*idle/)
  if (!idleMatch) return 0
  return 100 - parseFloat(idleMatch[1])
}

async function cpuUsageWindows(): Promise<number> {
  const out = await run(['wmic', 'cpu', 'get', 'loadpercentage', '/value'])
  const match = out.match(/LoadPercentage=(\d+)/i)
  return match ? parseInt(match[1]) : 0
}

async function getCpuUsage(): Promise<number> {
  const p = process.platform
  if (p === 'linux') return cpuUsageLinux()
  if (p === 'darwin') return cpuUsageMacOS()
  if (p === 'win32') return cpuUsageWindows()
  // fallback: nanoseconds-based busy estimation (very rough)
  const t0 = Bun.nanoseconds()
  await Bun.sleep(100)
  const elapsed = (Bun.nanoseconds() - t0) / 1e6
  return Math.min(100, Math.max(0, (elapsed - 100) * 0.5))
}

async function getCpuCoresAndModel(): Promise<{ cores: number; model: string }> {
  const p = process.platform
  if (p === 'linux') {
    const cpuinfo = await fileText('/proc/cpuinfo')
    const cores = (cpuinfo.match(/^processor\s*:/gm) ?? []).length || 1
    const modelMatch = cpuinfo.match(/^model name\s*:\s*(.+)/m)
    return { cores, model: modelMatch?.[1]?.trim() ?? 'Unknown' }
  }
  if (p === 'darwin') {
    const cores = parseInt(await run(['sysctl', '-n', 'hw.logicalcpu'])) || 1
    const model = await run(['sysctl', '-n', 'machdep.cpu.brand_string'])
    return { cores, model: model || 'Apple Silicon' }
  }
  if (p === 'win32') {
    const out = await run(['wmic', 'cpu', 'get', 'name,numberoflogicalprocessors', '/value'])
    const cores = parseInt(out.match(/NumberOfLogicalProcessors=(\d+)/i)?.[1] ?? '1')
    const model = out.match(/Name=(.+)/i)?.[1]?.trim() ?? 'Unknown'
    return { cores, model }
  }
  return { cores: 1, model: 'Unknown' }
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

async function getMemoryLinux(): Promise<{ usedMB: number; totalMB: number }> {
  const content = await fileText('/proc/meminfo')
  if (!content) return { usedMB: 0, totalMB: 0 }
  let total = 0, available = 0
  for (const line of content.split('\n')) {
    if (line.startsWith('MemTotal:')) total = parseInt(line.split(/\s+/)[1]) || 0
    else if (line.startsWith('MemAvailable:')) available = parseInt(line.split(/\s+/)[1]) || 0
  }
  return {
    totalMB: Math.round(total / 1024),
    usedMB: Math.round((total - available) / 1024),
  }
}

async function getMemoryMacOS(): Promise<{ usedMB: number; totalMB: number }> {
  const totalBytes = parseInt(await run(['sysctl', '-n', 'hw.memsize'])) || 0
  const totalMB = Math.round(totalBytes / 1024 / 1024)
  // vm_stat gives page counts; page size is typically 16384 on Apple Silicon, 4096 on Intel
  const vmStat = await run(['vm_stat'])
  const pageSize = parseInt(await run(['sysctl', '-n', 'hw.pagesize'])) || 4096
  const freePages = parseInt(vmStat.match(/Pages free:\s+(\d+)/)?.[1] ?? '0')
  const inactivePages = parseInt(vmStat.match(/Pages inactive:\s+(\d+)/)?.[1] ?? '0')
  const availableMB = Math.round((freePages + inactivePages) * pageSize / 1024 / 1024)
  return { totalMB, usedMB: Math.max(0, totalMB - availableMB) }
}

async function getMemoryWindows(): Promise<{ usedMB: number; totalMB: number }> {
  const out = await run([
    'wmic', 'os', 'get',
    'freephysicalmemory,totalvisiblememorysize',
    '/value',
  ])
  const total = parseInt(out.match(/TotalVisibleMemorySize=(\d+)/i)?.[1] ?? '0')
  const free = parseInt(out.match(/FreePhysicalMemory=(\d+)/i)?.[1] ?? '0')
  return {
    totalMB: Math.round(total / 1024),
    usedMB: Math.round((total - free) / 1024),
  }
}

async function getMemory(): Promise<{ usedMB: number; totalMB: number }> {
  const p = process.platform
  if (p === 'linux') return getMemoryLinux()
  if (p === 'darwin') return getMemoryMacOS()
  if (p === 'win32') return getMemoryWindows()
  return { usedMB: 0, totalMB: 0 }
}

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

async function getDisk(): Promise<{ usedPct: number; totalGB: number; availableGB: number }> {
  const p = process.platform
  if (p === 'win32') {
    // Get C: drive stats
    const out = await run([
      'wmic', 'logicaldisk', 'where', 'DeviceID="C:"',
      'get', 'freespace,size', '/value',
    ])
    const size = parseInt(out.match(/Size=(\d+)/i)?.[1] ?? '0')
    const free = parseInt(out.match(/FreeSpace=(\d+)/i)?.[1] ?? '0')
    if (!size) return { usedPct: 0, totalGB: 0, availableGB: 0 }
    const totalGB = size / 1e9
    const availableGB = free / 1e9
    return {
      usedPct: Math.round((1 - free / size) * 100),
      totalGB: Math.round(totalGB),
      availableGB: Math.round(availableGB),
    }
  }
  // Linux + macOS: df -k /
  const out = await run(['df', '-k', '/'])
  const lines = out.split('\n')
  const dataLine = lines[1] ?? ''
  const parts = dataLine.split(/\s+/)
  // df -k output: Filesystem  1K-blocks  Used  Available  Use%  Mounted
  const total1k = parseInt(parts[1]) || 0
  const avail1k = parseInt(parts[3]) || 0
  const usedPct = parseInt((parts[4] ?? '0').replace('%', '')) || 0
  return {
    usedPct,
    totalGB: Math.round(total1k / 1024 / 1024),
    availableGB: Math.round(avail1k / 1024 / 1024),
  }
}

// ---------------------------------------------------------------------------
// GPU
// ---------------------------------------------------------------------------

async function detectNvidiaGpu(): Promise<GpuInfo[]> {
  const out = await run([
    'nvidia-smi',
    '--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw',
    '--format=csv,noheader,nounits',
  ])
  if (!out) return []
  const gpus: GpuInfo[] = []
  for (const line of out.split('\n')) {
    const parts = line.split(',').map(s => s.trim())
    if (parts.length < 6) continue
    const [name, memTotal, memUsed, util, temp, power] = parts
    gpus.push({
      name: name ?? 'NVIDIA GPU',
      vendor: 'nvidia',
      vram_mb: parseInt(memTotal ?? '0') || 0,
      utilization_pct: parseInt(util ?? '0') || 0,
      temperature_c: parseFloat(temp ?? '0') || undefined,
      power_watts: parseFloat(power ?? '0') || undefined,
    })
  }
  return gpus
}

async function detectAppleGpu(): Promise<GpuInfo[]> {
  const out = await run(['system_profiler', 'SPDisplaysDataType', '-json'])
  if (!out) return []
  try {
    const data = JSON.parse(out) as Record<string, unknown>
    const displays = (data['SPDisplaysDataType'] as Record<string, unknown>[]) ?? []
    const gpus: GpuInfo[] = []
    for (const d of displays) {
      const name = String(d['spdisplays_vendor'] ?? d['sppci_model'] ?? 'Apple GPU')
      const vramStr = String(d['spdisplays_vram'] ?? d['spdisplays_vram_shared'] ?? '0')
      const vramMB = parseVramString(vramStr)
      gpus.push({
        name,
        vendor: 'apple',
        vram_mb: vramMB,
        utilization_pct: 0, // Apple Silicon: no easy query without powermetrics (needs root)
      })
    }
    return gpus
  } catch {
    return []
  }
}

function parseVramString(s: string): number {
  const match = s.match(/(\d+)\s*(MB|GB)/i)
  if (!match) return 0
  const val = parseInt(match[1])
  return match[2].toUpperCase() === 'GB' ? val * 1024 : val
}

async function detectAmdGpu(): Promise<GpuInfo[]> {
  const out = await run(['rocm-smi', '--showmeminfo', 'vram', '--csv'])
  if (!out) return []
  const gpus: GpuInfo[] = []
  const lines = out.split('\n').slice(1) // skip header
  for (const line of lines) {
    if (!line.trim()) continue
    const parts = line.split(',')
    // rocm-smi CSV: device, VRAM Total Memory (B), VRAM Total Used Memory (B)
    const total = parseInt(parts[1] ?? '0') || 0
    const used = parseInt(parts[2] ?? '0') || 0
    gpus.push({
      name: `AMD GPU ${parts[0]?.trim() ?? ''}`.trim(),
      vendor: 'amd',
      vram_mb: Math.round(total / 1024 / 1024),
      utilization_pct: total > 0 ? Math.round((used / total) * 100) : 0,
    })
  }
  return gpus
}

async function detectGpus(): Promise<GpuInfo[]> {
  // Try all in parallel; use whichever returns first with results
  const [nvidia, amd, apple] = await Promise.all([
    detectNvidiaGpu().catch(() => [] as GpuInfo[]),
    process.platform !== 'darwin' ? detectAmdGpu().catch(() => [] as GpuInfo[]) : Promise.resolve([] as GpuInfo[]),
    process.platform === 'darwin' ? detectAppleGpu().catch(() => [] as GpuInfo[]) : Promise.resolve([] as GpuInfo[]),
  ])
  return [...nvidia, ...amd, ...apple]
}

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

async function commandExists(cmd: string): Promise<boolean> {
  const whichCmd = process.platform === 'win32' ? ['where', cmd] : ['which', cmd]
  const out = await run(whichCmd)
  return out.length > 0
}

async function isDocker(): Promise<boolean> {
  if (process.platform === 'linux') {
    const cgroup = await fileText('/proc/1/cgroup')
    if (cgroup.includes('docker') || cgroup.includes('containerd')) return true
    // /.dockerenv exists in all Docker containers (may be empty)
    if (await Bun.file('/.dockerenv').exists()) return true
  }
  return false
}

async function detectRuntimes(): Promise<Runtime[]> {
  const runtimes: Runtime[] = ['native']
  const [docker, podman, bunExists, python] = await Promise.all([
    isDocker(),
    commandExists('podman'),
    commandExists('bun'),
    commandExists('python3').then(r => r || commandExists('python')),
  ])
  if (docker) runtimes.push('docker')
  if (podman) runtimes.push('podman')
  if (bunExists) runtimes.push('bun')
  if (python) runtimes.push('python')
  // Check for lxc
  if (process.platform === 'linux') {
    const cgroup = await fileText('/proc/1/cgroup')
    if (cgroup.includes('lxc')) runtimes.push('lxc')
  }
  return runtimes
}

// ---------------------------------------------------------------------------
// Network type
// ---------------------------------------------------------------------------

async function detectNetworkType(): Promise<NetworkType> {
  const p = process.platform
  if (p === 'linux') {
    const out = await run(['ls', '/sys/class/net/'])
    if (out.includes('wlan') || out.includes('wlp')) return 'wifi'
    if (out.includes('eth') || out.includes('enp') || out.includes('eno')) return 'wired'
  }
  if (p === 'darwin') {
    const out = await run(['networksetup', '-listallhardwareports'])
    const activeWifi = out.match(/Wi-Fi|AirPort/i)
    if (activeWifi) return 'wifi'
    return 'wired'
  }
  if (p === 'win32') {
    const out = await run(['netsh', 'wlan', 'show', 'interfaces'])
    if (out.includes('State') && out.includes('connected')) return 'wifi'
    return 'wired'
  }
  return 'wired'
}

// ---------------------------------------------------------------------------
// Battery
// ---------------------------------------------------------------------------

async function getBattery(): Promise<{ pct?: number; charging?: boolean }> {
  const p = process.platform
  if (p === 'linux') {
    const supplies = await run(['ls', '/sys/class/power_supply/'])
    const batDir = supplies.split('\n').find(s => s.toLowerCase().startsWith('bat'))
    if (!batDir) return {}
    const base = `/sys/class/power_supply/${batDir.trim()}`
    const [cap, status] = await Promise.all([
      fileText(`${base}/capacity`),
      fileText(`${base}/status`),
    ])
    const pct = parseInt(cap.trim())
    return {
      pct: isNaN(pct) ? undefined : pct,
      charging: status.trim() === 'Charging',
    }
  }
  if (p === 'darwin') {
    const out = await run(['pmset', '-g', 'batt'])
    const pctMatch = out.match(/(\d+)%/)
    const charging = out.includes('AC Power') || out.includes('charging')
    return {
      pct: pctMatch ? parseInt(pctMatch[1]) : undefined,
      charging,
    }
  }
  if (p === 'win32') {
    const out = await run([
      'wmic', 'path', 'win32_battery',
      'get', 'estimatedchargeremaining,batterystatus',
      '/value',
    ])
    const pct = parseInt(out.match(/EstimatedChargeRemaining=(\d+)/i)?.[1] ?? 'NaN')
    const statusCode = parseInt(out.match(/BatteryStatus=(\d+)/i)?.[1] ?? '0')
    // BatteryStatus: 2 = AC power (no battery), 1 = discharging, 3/6 = charging
    if (!out.trim() || statusCode === 2) return {}
    return {
      pct: isNaN(pct) ? undefined : pct,
      charging: statusCode === 3 || statusCode === 6,
    }
  }
  return {}
}

// ---------------------------------------------------------------------------
// Platform/Arch
// ---------------------------------------------------------------------------

function detectPlatform(): Platform {
  switch (process.platform) {
    case 'linux': return 'linux'
    case 'darwin': return 'darwin'
    case 'win32': return 'windows'
    default: return 'linux'
  }
}

function detectArch(): Arch {
  switch (process.arch) {
    case 'x64': return 'x86_64'
    case 'arm64': return 'aarch64'
    case 'arm': return 'armv7'
    default: return 'x86_64'
  }
}

async function getHostname(): Promise<string> {
  const p = process.platform
  const out = p === 'win32'
    ? await run(['hostname'])
    : await run(['hostname', '-s'])
  return out || 'unknown'
}

// ---------------------------------------------------------------------------
// Sandbox detection
// ---------------------------------------------------------------------------

async function detectSandbox(): Promise<boolean> {
  if (process.platform !== 'linux') return false
  // bubblewrap
  if (await commandExists('bwrap')) return true
  // check if we're already inside a container (Docker provides its own isolation)
  const cgroup = await fileText('/proc/1/cgroup')
  return cgroup.includes('docker') || cgroup.includes('lxc')
}

// ---------------------------------------------------------------------------
// Public: full capability snapshot
// ---------------------------------------------------------------------------

export async function collectDeviceCapability(deviceId: string): Promise<DeviceCapability> {
  const [
    cpuInfo,
    cpuUsage,
    memory,
    disk,
    gpus,
    runtimes,
    networkType,
    battery,
    hostname,
    sandbox,
  ] = await Promise.all([
    getCpuCoresAndModel(),
    getCpuUsage(),
    getMemory(),
    getDisk(),
    detectGpus(),
    detectRuntimes(),
    detectNetworkType(),
    getBattery(),
    getHostname(),
    detectSandbox(),
  ])

  const now = Date.now()

  return {
    device_id: deviceId,
    hostname,
    platform: detectPlatform(),
    arch: detectArch(),
    cpu_cores: cpuInfo.cores,
    cpu_model: cpuInfo.model,
    memory_total_mb: memory.totalMB,
    memory_available_mb: memory.totalMB - memory.usedMB,
    disk_total_gb: disk.totalGB,
    disk_available_gb: disk.availableGB,
    gpus,
    runtimes,
    network_type: networkType,
    nat_type: 'full_cone', // requires STUN probe; default to conservative
    can_run_tasks: true,
    can_serve_inference: gpus.length > 0,
    inference_models: [],
    max_concurrent_tasks: Math.max(1, cpuInfo.cores - 1),
    trust_level: 'community',
    sandbox_available: sandbox,
    battery_pct: battery.pct,
    charging: battery.charging,
    online_since: now,
    last_heartbeat: now,
    ephemeral: battery.pct !== undefined, // has battery = possibly mobile/laptop
    tags: [],
  }
}

// ---------------------------------------------------------------------------
// Public: lightweight heartbeat metrics (skip slow GPU/runtime detection)
// ---------------------------------------------------------------------------

export async function collectHeartbeatMetrics(activeTasks = 0): Promise<HeartbeatMetrics> {
  const [cpuUsage, memory, disk, battery] = await Promise.all([
    getCpuUsage(),
    getMemory(),
    getDisk(),
    getBattery(),
  ])

  // Quick GPU check: re-use last nvidia-smi result if available (fast path)
  let gpuUtil: number | undefined
  let gpuVram: number | undefined
  let gpuTemp: number | undefined

  const nvidiaOut = await run([
    'nvidia-smi',
    '--query-gpu=utilization.gpu,memory.used,temperature.gpu',
    '--format=csv,noheader,nounits',
  ])
  if (nvidiaOut) {
    const parts = nvidiaOut.split('\n')[0]?.split(',').map(s => s.trim()) ?? []
    if (parts.length >= 2) {
      gpuUtil = parseInt(parts[0] ?? '0') || undefined
      gpuVram = parseInt(parts[1] ?? '0') || undefined
      gpuTemp = parseFloat(parts[2] ?? '0') || undefined
    }
  }

  return {
    cpu_usage_pct: Math.round(cpuUsage * 100) / 100,
    memory_used_mb: memory.usedMB,
    memory_total_mb: memory.totalMB,
    disk_used_pct: disk.usedPct,
    gpu_utilization_pct: gpuUtil,
    gpu_vram_used_mb: gpuVram,
    gpu_temperature_c: gpuTemp,
    active_tasks: activeTasks,
    battery_pct: battery.pct,
  }
}
