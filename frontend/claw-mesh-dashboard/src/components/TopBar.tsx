import { useMeshStore } from '../stores/useMeshStore';

const NODE_LABELS: Record<string, { flag: string; short: string }> = {
  central: { flag: 'CN', short: '中央' },
  silicon: { flag: 'SV', short: '硅谷' },
  tokyo:   { flag: 'TK', short: '东京' },
};

export function TopBar() {
  const nodes = useMeshStore((s) => s.nodes);

  return (
    <header className="glass-surface flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
      <div className="flex items-center gap-3">
        <span className="text-lg font-heading font-semibold tracking-tight" style={{ color: 'var(--color-primary)' }}>
          FSC-Mesh Control
        </span>
        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>v0.3.0</span>
      </div>

      <div className="flex items-center gap-4">
        {(Object.keys(nodes) as Array<keyof typeof nodes>).map((key) => {
          const node = nodes[key];
          const meta = NODE_LABELS[key];
          return (
            <div key={key} className="flex items-center gap-1.5 text-xs font-mono">
              <span style={{ color: 'var(--text-secondary)' }}>{meta.flag}</span>
              <span className={`status-dot ${node.online ? 'status-online' : 'status-offline'}`} />
            </div>
          );
        })}

        <div className="w-px h-4 bg-white/10" />

        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {new Date().toLocaleTimeString('zh-CN', { hour12: false })}
        </span>
      </div>
    </header>
  );
}
