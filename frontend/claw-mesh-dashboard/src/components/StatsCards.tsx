import { GlassCard } from './ui/GlassCard';
import { useTaskStore } from '../stores/useTaskStore';
import { useMeshStore } from '../stores/useMeshStore';

interface StatCardData {
  label: string;
  value: string | number;
  sub?: string;
  color: string;
  glow: 'primary' | 'success' | 'error' | 'none';
}

export function StatsCards() {
  const queue = useTaskStore((s) => s.queue);
  const successRate = useTaskStore((s) => s.successRate);
  const workerLoad = useTaskStore((s) => s.workerLoad);
  const nodes = useMeshStore((s) => s.nodes);

  const onlineCount = Object.values(nodes).filter((n) => n.online).length;
  const totalTasks = queue ? queue.pending + queue.processing + queue.completed + queue.failed : 0;
  const runningAgents = workerLoad?.running ?? 0;

  const cards: StatCardData[] = [
    {
      label: 'Agents',
      value: runningAgents,
      sub: `${onlineCount}/3 nodes`,
      color: 'var(--color-primary)',
      glow: 'primary',
    },
    {
      label: 'Tasks',
      value: totalTasks,
      sub: queue ? `${queue.pending} pending` : '—',
      color: 'var(--color-info)',
      glow: 'primary',
    },
    {
      label: 'Success',
      value: `${successRate.toFixed(1)}%`,
      sub: queue ? `${queue.completed}/${queue.completed + queue.failed}` : '—',
      color: 'var(--color-success)',
      glow: 'success',
    },
    {
      label: 'Cost',
      value: `$${(totalTasks * 0.001).toFixed(3)}`,
      sub: 'estimated',
      color: 'var(--color-warning)',
      glow: 'none',
    },
  ];

  return (
    <div className="grid grid-cols-4 gap-3">
      {cards.map((card) => (
        <GlassCard key={card.label} glow={card.glow} className="animate-fade-in">
          <div className="text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>
            {card.label}
          </div>
          <div className="text-2xl font-heading font-bold tracking-tight" style={{ color: card.color }}>
            {card.value}
          </div>
          {card.sub && (
            <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
              {card.sub}
            </div>
          )}
        </GlassCard>
      ))}
    </div>
  );
}
