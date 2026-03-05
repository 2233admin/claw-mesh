import { useGovernanceStore } from '../stores/useGovernanceStore';
import { GlassCard } from './ui/GlassCard';

// ============ Trust Leaderboard ============
function TrustLeaderboard() {
  const entries = useGovernanceStore((s) => s.trustLeaderboard);

  return (
    <GlassCard title="Agent Trust Leaderboard" icon="⚖">
      <div className="space-y-1.5 max-h-52 overflow-y-auto">
        {entries.length === 0 && (
          <div className="text-[10px] text-center py-4" style={{ color: 'var(--text-muted)' }}>
            No agents registered yet
          </div>
        )}
        {entries.map((e, i) => (
          <div key={e.agentId} className="flex items-center gap-2 px-2 py-1.5 rounded-md"
            style={{ background: 'rgba(255,255,255,0.03)' }}>
            <span className="text-[10px] font-mono w-4 text-right" style={{ color: 'var(--text-muted)' }}>
              {i + 1}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-mono truncate" style={{ color: 'var(--text-primary)' }}>
                  {e.agentId}
                </span>
                {e.cooldown && (
                  <span className="text-[9px] px-1 rounded" style={{ background: 'rgba(239,68,68,0.15)', color: 'var(--color-error)' }}>
                    COOLDOWN
                  </span>
                )}
              </div>
              <div className="flex gap-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                <span>Tasks: {e.totalTasks}</span>
                <span>Win: {Math.round(e.successRate * 100)}%</span>
                <span>Q: {e.avgQuality.toFixed(0)}</span>
              </div>
            </div>
            <TrustBadge score={e.score} />
          </div>
        ))}
      </div>
    </GlassCard>
  );
}

function TrustBadge({ score }: { score: number }) {
  const color = score >= 80 ? 'var(--color-success)' : score >= 50 ? 'var(--color-primary)' : score >= 30 ? 'var(--color-warning)' : 'var(--color-error)';
  return (
    <div className="flex flex-col items-center">
      <span className="text-sm font-bold font-mono" style={{ color }}>{score.toFixed(0)}</span>
      <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>trust</span>
    </div>
  );
}

// ============ Budget Gauge ============
function BudgetPanel() {
  const b = useGovernanceStore((s) => s.budget);

  const tierColor: Record<string, string> = {
    premium: 'var(--color-success)',
    standard: 'var(--color-primary)',
    economy: 'var(--color-warning)',
    free: 'var(--color-accent, #c084fc)',
    paused: 'var(--color-error)',
  };

  return (
    <GlassCard title="Cost Control" icon="$">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Model Tier</span>
          <span className="text-xs font-mono font-bold px-2 py-0.5 rounded"
            style={{ color: tierColor[b.tier] || 'var(--text-primary)', background: 'rgba(255,255,255,0.05)' }}>
            {b.tier.toUpperCase()} — {b.model}
          </span>
        </div>

        <UsageBar label="Hourly" usage={b.hourlyUsage} />
        <UsageBar label="Daily" usage={b.dailyUsage} />
        <UsageBar label="Monthly" usage={b.monthlyUsage} />

        {!b.canAccept && (
          <div className="text-[10px] text-center py-1 rounded" style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--color-error)' }}>
            PAUSED — Budget exceeded, no new tasks accepted
          </div>
        )}
      </div>
    </GlassCard>
  );
}

function UsageBar({ label, usage }: { label: string; usage: number }) {
  const color = usage >= 100 ? 'var(--color-error)' : usage >= 80 ? 'var(--color-warning)' : 'var(--color-primary)';
  return (
    <div>
      <div className="flex justify-between text-[10px] mb-0.5">
        <span style={{ color: 'var(--text-muted)' }}>{label}</span>
        <span style={{ color }}>{usage}%</span>
      </div>
      <div className="h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.min(usage, 100)}%`, background: color }} />
      </div>
    </div>
  );
}

// ============ Quality Distribution ============
function QualityPanel() {
  const q = useGovernanceStore((s) => s.quality);
  const total = q.total || 1;

  return (
    <GlassCard title="Quality Gate" icon="✓">
      <div className="flex items-center gap-4">
        <div className="flex-1 space-y-2">
          <QualityStat label="APPROVE" count={q.approved} total={total} color="var(--color-success)" />
          <QualityStat label="REVIEW" count={q.review} total={total} color="var(--color-warning)" />
          <QualityStat label="REJECT" count={q.rejected} total={total} color="var(--color-error)" />
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold font-mono" style={{ color: 'var(--color-primary)' }}>
            {q.avgScore.toFixed(0)}
          </div>
          <div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>avg score</div>
          <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>{q.total} total</div>
        </div>
      </div>
    </GlassCard>
  );
}

function QualityStat({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = Math.round((count / total) * 100);
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] w-14 font-mono" style={{ color }}>{label}</span>
      <div className="flex-1 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-[10px] font-mono w-8 text-right" style={{ color: 'var(--text-muted)' }}>{count}</span>
    </div>
  );
}

// ============ Evolution Strategy ============
function EvolutionPanel() {
  const strategy = useGovernanceStore((s) => s.evolutionStrategy);
  const diversity = useGovernanceStore((s) => s.diversityIndex);

  const strategyInfo: Record<string, { explore: string; color: string }> = {
    balanced: { explore: '30%', color: 'var(--color-primary)' },
    innovate: { explore: '60%', color: 'var(--color-warning)' },
    harden: { explore: '10%', color: 'var(--color-success)' },
    'repair-only': { explore: '0%', color: 'var(--color-error)' },
    auto: { explore: 'auto', color: 'var(--color-accent, #c084fc)' },
  };

  const info = strategyInfo[strategy] || strategyInfo.balanced;

  return (
    <GlassCard title="Evolution" icon="↻">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-mono font-bold" style={{ color: info.color }}>
            {strategy.toUpperCase()}
          </div>
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            Exploration: {info.explore}
          </div>
        </div>
        <div className="text-center">
          <div className="text-lg font-mono font-bold" style={{ color: diversity < 0.3 ? 'var(--color-error)' : 'var(--color-success)' }}>
            {diversity.toFixed(2)}
          </div>
          <div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>diversity</div>
        </div>
      </div>
    </GlassCard>
  );
}

// ============ Audit Log (compact) ============
function AuditPanel() {
  const entries = useGovernanceStore((s) => s.auditLog);

  const typeColor: Record<string, string> = {
    task_validated: 'var(--color-success)',
    task_rejected: 'var(--color-error)',
    trust_updated: 'var(--color-primary)',
    quality_checked: 'var(--color-warning)',
    budget_warning: 'var(--color-warning)',
    budget_exceeded: 'var(--color-error)',
    model_downgraded: 'var(--color-warning)',
    policy_violation: 'var(--color-error)',
  };

  return (
    <GlassCard title="Governance Audit Log" icon="☵">
      <div className="space-y-1 max-h-64 overflow-y-auto">
        {entries.length === 0 && (
          <div className="text-[10px] text-center py-4" style={{ color: 'var(--text-muted)' }}>
            No audit events yet
          </div>
        )}
        {entries.slice(0, 50).map((e) => (
          <div key={e.id} className="flex items-center gap-2 text-[10px] font-mono py-0.5">
            <span style={{ color: 'var(--text-muted)' }}>
              {new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
            </span>
            <span className="px-1 rounded" style={{ color: typeColor[e.eventType] || 'var(--text-secondary)', background: 'rgba(255,255,255,0.03)' }}>
              {e.eventType}
            </span>
            {e.agentId && <span style={{ color: 'var(--text-secondary)' }}>{e.agentId}</span>}
            {e.decision && <span style={{ color: e.decision === 'allow' ? 'var(--color-success)' : 'var(--color-error)' }}>{e.decision}</span>}
            <span className="truncate flex-1" style={{ color: 'var(--text-muted)' }}>{e.details}</span>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}

// ============ Policy Rules ============
function PolicyPanel() {
  const policies = useGovernanceStore((s) => s.policies);

  return (
    <GlassCard title="Policy Rules" icon="⚑">
      <div className="space-y-1 max-h-40 overflow-y-auto">
        {policies.map((p) => (
          <div key={p.id} className="flex items-center gap-2 text-[10px] font-mono py-1 px-2 rounded"
            style={{ background: 'rgba(255,255,255,0.03)' }}>
            <span className="w-2 h-2 rounded-full"
              style={{ background: p.enabled ? (p.enforcement === 'hard' ? 'var(--color-error)' : 'var(--color-warning)') : 'var(--text-muted)' }} />
            <span className="w-20 truncate" style={{ color: 'var(--text-primary)' }}>{p.id}</span>
            <span className="flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>{p.name}</span>
            <span style={{ color: p.level === 'constitutional' ? 'var(--color-error)' : 'var(--text-muted)' }}>
              {p.level === 'constitutional' ? 'CONST' : 'OPS'}
            </span>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}

// ============ Free Providers Panel ============
function FreeProvidersPanel() {
  const endpoints = useGovernanceStore((s) => s.freeProviders);
  const summary = useGovernanceStore((s) => s.freeProviderSummary);

  const circuitColor: Record<string, string> = {
    closed: 'var(--color-success)',
    'half-open': 'var(--color-warning)',
    open: 'var(--color-error)',
  };

  return (
    <GlassCard title="Free Providers" icon="F">
      <div className="space-y-2">
        {/* Summary bar */}
        <div className="flex items-center gap-3 text-[10px] font-mono px-2 py-1.5 rounded"
          style={{ background: 'rgba(255,255,255,0.03)' }}>
          <span style={{ color: 'var(--text-muted)' }}>Total: {summary.total}</span>
          <span style={{ color: 'var(--color-success)' }}>Healthy: {summary.healthy}</span>
          {summary.halfOpen > 0 && <span style={{ color: 'var(--color-warning)' }}>Half-Open: {summary.halfOpen}</span>}
          {summary.open > 0 && <span style={{ color: 'var(--color-error)' }}>Open: {summary.open}</span>}
        </div>

        {/* Endpoint list */}
        <div className="space-y-1 max-h-40 overflow-y-auto">
          {endpoints.length === 0 && (
            <div className="text-[10px] text-center py-3" style={{ color: 'var(--text-muted)' }}>
              No free endpoints configured — add via Settings
            </div>
          )}
          {endpoints.map((ep) => (
            <div key={ep.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md"
              style={{ background: 'rgba(255,255,255,0.03)' }}>
              {/* Circuit status dot */}
              <span className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: ep.enabled ? (circuitColor[ep.circuit.status] || 'var(--text-muted)') : 'var(--text-muted)' }} />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-mono truncate" style={{ color: 'var(--text-primary)' }}>
                  {ep.model}
                </div>
                <div className="flex gap-2 text-[9px]" style={{ color: 'var(--text-muted)' }}>
                  <span>{ep.provider}</span>
                  <span>Req: {ep.circuit.totalRequests}</span>
                  <span>Fail: {ep.circuit.totalFailures}</span>
                </div>
              </div>
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                style={{
                  color: circuitColor[ep.circuit.status] || 'var(--text-muted)',
                  background: 'rgba(255,255,255,0.05)',
                }}>
                {ep.circuit.status.toUpperCase()}
              </span>
              {!ep.enabled && (
                <span className="text-[9px] px-1 rounded" style={{ background: 'rgba(239,68,68,0.15)', color: 'var(--color-error)' }}>
                  OFF
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </GlassCard>
  );
}

// ============ Main Governance View ============
export function GovernancePanel() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <BudgetPanel />
        <QualityPanel />
        <EvolutionPanel />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <TrustLeaderboard />
        <FreeProvidersPanel />
      </div>
      <PolicyPanel />
      <AuditPanel />
    </div>
  );
}
