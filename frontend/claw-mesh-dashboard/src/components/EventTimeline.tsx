import { useEventStore, type MeshEvent } from '../stores/useEventStore';

const STATUS_STYLES: Record<string, { dot: string; text: string }> = {
  success: { dot: 'status-online', text: 'var(--color-success)' },
  failure: { dot: 'status-offline', text: 'var(--color-error)' },
  pending: { dot: 'status-warning', text: 'var(--color-warning)' },
  info:    { dot: '', text: 'var(--text-secondary)' },
};

const TYPE_ICON: Record<string, string> = {
  task_started:    '⋯',
  task_complete:   '✓',
  task_failure:    '✗',
  network_healed:  '↻',
  worker_shutdown: '◼',
  config_changed:  '⚙',
  context_update:  '↺',
  shared_update:   '↔',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function EventRow({ event }: { event: MeshEvent }) {
  const style = STATUS_STYLES[event.status] || STATUS_STYLES.info;
  const icon = TYPE_ICON[event.type] || '●';

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 hover:bg-white/[0.03] transition-colors animate-slide-up">
      <span className="font-mono text-[10px] w-16 shrink-0" style={{ color: 'var(--text-muted)' }}>
        {formatTime(event.timestamp)}
      </span>
      <span className={`status-dot ${style.dot} shrink-0`} />
      <span className="font-mono text-xs w-20 shrink-0 truncate" style={{ color: 'var(--text-secondary)' }}>
        {event.agentId}
      </span>
      <span className="font-mono text-xs w-24 shrink-0" style={{ color: style.text }}>
        {event.type}
      </span>
      <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
        {icon}
      </span>
      {event.message && (
        <span className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
          {event.message}
        </span>
      )}
    </div>
  );
}

export function EventTimeline() {
  const events = useEventStore((s) => s.events);
  const clearEvents = useEventStore((s) => s.clearEvents);

  return (
    <div className="glass-card flex flex-col overflow-hidden" style={{ height: '100%' }}>
      <div className="px-4 py-2 border-b border-white/[0.06] flex items-center justify-between shrink-0">
        <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
          Event Timeline
        </span>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
            {events.length} events
          </span>
          {events.length > 0 && (
            <button
              onClick={clearEvents}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{
                color: 'var(--text-muted)',
                background: 'rgba(255,255,255,0.05)',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {events.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>等待事件...</span>
          </div>
        ) : (
          events.map((event) => <EventRow key={event.id} event={event} />)
        )}
      </div>
    </div>
  );
}
