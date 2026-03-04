interface NavItem {
  id: string;
  icon: string;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'mesh',  icon: '◉', label: 'Mesh' },
  { id: 'tasks', icon: '◫', label: 'Tasks' },
  { id: 'governance', icon: '⚖', label: 'Governance' },
  { id: 'logs',  icon: '☵', label: 'Logs' },
  { id: 'ai',    icon: '★', label: 'AI' },
  { id: 'settings', icon: '⚙', label: 'Settings' },
];

interface SidebarProps {
  active: string;
  onNavigate: (id: string) => void;
}

export function Sidebar({ active, onNavigate }: SidebarProps) {

  return (
    <nav className="glass-surface flex flex-col border-r border-white/[0.06] w-14 shrink-0">
      <div className="flex-1 flex flex-col items-center gap-1 pt-3">
        {NAV_ITEMS.map((item) => {
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className="w-10 h-10 flex items-center justify-center rounded-lg transition-all text-sm"
              style={{
                background: isActive ? 'rgba(96, 165, 250, 0.15)' : 'transparent',
                color: isActive ? 'var(--color-primary)' : 'var(--text-muted)',
                border: 'none',
                cursor: 'pointer',
              }}
              title={item.label}
            >
              {item.icon}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
