import { useState } from 'react';

const STAR_OFFICE_URL = '/star-office';

export function StarOfficePanel() {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  return (
    <div className="glass-card overflow-hidden flex flex-col" style={{ height: '100%', minHeight: 280 }}>
      <div className="px-4 py-2 border-b border-white/[0.06] flex items-center justify-between">
        <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
          Star Office — Agent 可视化
        </span>
        <a
          href={STAR_OFFICE_URL}
          target="_blank"
          rel="noopener"
          className="text-[10px] font-mono"
          style={{ color: 'var(--text-muted)' }}
        >
          ↗ 打开
        </a>
      </div>

      <div className="flex-1 relative">
        {!loaded && !error && (
          <div className="absolute inset-0 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
            <span className="text-xs animate-pulse-glow">连接 Star Office...</span>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2" style={{ color: 'var(--text-muted)' }}>
            <span className="text-xs">Star Office 未启动</span>
            <span className="text-[10px] font-mono">期望: {STAR_OFFICE_URL}</span>
          </div>
        )}

        <iframe
          src={STAR_OFFICE_URL}
          className="w-full h-full border-0"
          style={{ display: error ? 'none' : 'block', background: 'transparent' }}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          sandbox="allow-scripts allow-same-origin"
          title="Star Office Agent Visualization"
        />
      </div>
    </div>
  );
}
