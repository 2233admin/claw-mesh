interface GlassCardProps {
  children: React.ReactNode;
  className?: string;
  glow?: 'primary' | 'success' | 'error' | 'none';
  onClick?: () => void;
}

const glowMap = {
  primary: 'hover:shadow-[0_0_20px_rgba(96,165,250,0.15)]',
  success: 'hover:shadow-[0_0_20px_rgba(52,211,153,0.15)]',
  error: 'hover:shadow-[0_0_20px_rgba(248,113,113,0.15)]',
  none: '',
};

export function GlassCard({ children, className = '', glow = 'none', onClick }: GlassCardProps) {
  return (
    <div
      className={`glass-card p-4 ${glowMap[glow]} ${onClick ? 'cursor-pointer' : ''} ${className}`}
      onClick={onClick}
    >
      {children}
    </div>
  );
}
