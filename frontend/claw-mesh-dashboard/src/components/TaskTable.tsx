import { useTaskStore } from '../stores/useTaskStore';
import { GlassCard } from './ui/GlassCard';

interface TaskRow {
  id: string;
  label: string;
  value: number;
  color: string;
  barPercent: number;
}

export function TaskTable() {
  const queue = useTaskStore((s) => s.queue);
  const workerLoad = useTaskStore((s) => s.workerLoad);

  if (!queue) {
    return (
      <GlassCard className="animate-fade-in">
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          加载任务数据...
        </div>
      </GlassCard>
    );
  }

  const total = queue.pending + queue.processing + queue.completed + queue.failed;
  const rows: TaskRow[] = [
    { id: 'pending',    label: 'Pending',    value: queue.pending,    color: 'var(--color-warning)', barPercent: total ? (queue.pending / total) * 100 : 0 },
    { id: 'processing', label: 'Processing', value: queue.processing, color: 'var(--color-primary)', barPercent: total ? (queue.processing / total) * 100 : 0 },
    { id: 'completed',  label: 'Completed',  value: queue.completed,  color: 'var(--color-success)', barPercent: total ? (queue.completed / total) * 100 : 0 },
    { id: 'failed',     label: 'Failed',     value: queue.failed,     color: 'var(--color-error)',   barPercent: total ? (queue.failed / total) * 100 : 0 },
  ];

  return (
    <GlassCard className="animate-fade-in">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
          Task Queue
        </span>
        {workerLoad && (
          <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
            {workerLoad.running}/{workerLoad.maxConcurrent} workers
          </span>
        )}
      </div>

      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center gap-3">
            <span className="text-xs w-20 shrink-0" style={{ color: 'var(--text-muted)' }}>
              {row.label}
            </span>
            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${row.barPercent}%`, background: row.color }}
              />
            </div>
            <span className="text-xs font-mono w-10 text-right" style={{ color: row.color }}>
              {row.value}
            </span>
          </div>
        ))}
      </div>

      {workerLoad && (
        <div className="mt-3 pt-3 border-t border-white/[0.06] grid grid-cols-3 gap-2">
          <div>
            <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>CPU</div>
            <div className="text-xs font-mono" style={{ color: 'var(--text-primary)' }}>{workerLoad.cpuUsage}%</div>
          </div>
          <div>
            <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Memory</div>
            <div className="text-xs font-mono" style={{ color: 'var(--text-primary)' }}>{workerLoad.memoryUsage}</div>
          </div>
          <div>
            <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Disk</div>
            <div className="text-xs font-mono" style={{ color: 'var(--text-primary)' }}>{workerLoad.diskUsage}</div>
          </div>
        </div>
      )}
    </GlassCard>
  );
}
