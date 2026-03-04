import { useMemo, useState, useCallback } from 'react';
import ReactFlow, {
  Background,
  Controls,
  type Node,
  type Edge,
  Position,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useMeshStore } from '../stores/useMeshStore';

// ============ LOD: 域/节点双视图 ============
type ViewLevel = 'domain' | 'node';

// 域级别聚合数据（用于 1000+ 节点场景）
interface DomainInfo {
  id: string;
  label: string;
  nodeCount: number;
  onlineCount: number;
  avgLoad: number;
}

const NODE_POSITIONS: Record<string, { x: number; y: number }> = {
  central: { x: 200, y: 40 },
  silicon: { x: 50, y: 200 },
  tokyo:   { x: 350, y: 200 },
};

const NODE_META: Record<string, { label: string; flag: string; domain: string }> = {
  central: { label: '中央节点', flag: 'CN', domain: 'domain-cn' },
  silicon: { label: '硅谷节点', flag: 'SV', domain: 'domain-sv' },
  tokyo:   { label: '东京节点', flag: 'TK', domain: 'domain-tk' },
};

// 域聚合位置（LOD 高层视图）
const DOMAIN_POSITIONS: Record<string, { x: number; y: number }> = {
  'domain-cn': { x: 200, y: 40 },
  'domain-sv': { x: 50, y: 200 },
  'domain-tk': { x: 350, y: 200 },
};

function NodeLabel({ id, online }: { id: string; online: boolean }) {
  const meta = NODE_META[id] || { label: id, flag: '?' };
  return (
    <div className="flex flex-col items-center gap-1 py-1 px-3">
      <div className="flex items-center gap-1.5">
        <span className={`status-dot ${online ? 'status-online' : 'status-offline'}`} />
        <span className="font-mono text-xs font-semibold">{meta.flag}</span>
      </div>
      <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>{meta.label}</span>
    </div>
  );
}

function DomainLabel({ domain, onlineCount, totalCount }: { domain: DomainInfo; onlineCount: number; totalCount: number }) {
  const allOnline = onlineCount === totalCount;
  return (
    <div className="flex flex-col items-center gap-1 py-2 px-4">
      <div className="flex items-center gap-1.5">
        <span className={`status-dot ${allOnline ? 'status-online' : onlineCount > 0 ? 'status-warning' : 'status-offline'}`} />
        <span className="font-mono text-xs font-semibold">{domain.label}</span>
      </div>
      <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
        {onlineCount}/{totalCount} nodes
      </span>
    </div>
  );
}

export function MeshTopology() {
  const meshNodes = useMeshStore((s) => s.nodes);
  const [viewLevel, setViewLevel] = useState<ViewLevel>('node');

  // 域聚合计算
  const domains: DomainInfo[] = useMemo(() => {
    const domainMap = new Map<string, { online: number; total: number }>();
    for (const [id, data] of Object.entries(meshNodes)) {
      const meta = NODE_META[id];
      if (!meta) continue;
      const d = domainMap.get(meta.domain) || { online: 0, total: 0 };
      d.total++;
      if (data.online) d.online++;
      domainMap.set(meta.domain, d);
    }

    return Array.from(domainMap.entries()).map(([domainId, counts]) => ({
      id: domainId,
      label: domainId.replace('domain-', '').toUpperCase(),
      nodeCount: counts.total,
      onlineCount: counts.online,
      avgLoad: 0,
    }));
  }, [meshNodes]);

  // 节点视图
  const nodeFlowNodes: Node[] = useMemo(
    () =>
      Object.entries(meshNodes).map(([id, data]) => ({
        id,
        position: NODE_POSITIONS[id] || { x: 0, y: 0 },
        data: { label: <NodeLabel id={id} online={data.online} /> },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        draggable: true,
        style: {
          background: data.online ? 'rgba(52, 211, 153, 0.08)' : 'rgba(248, 113, 113, 0.08)',
          border: `1px solid ${data.online ? 'rgba(52, 211, 153, 0.3)' : 'rgba(248, 113, 113, 0.3)'}`,
          borderRadius: '12px',
          padding: '4px',
        },
      })),
    [meshNodes]
  );

  // 域聚合视图
  const domainFlowNodes: Node[] = useMemo(
    () =>
      domains.map((d) => ({
        id: d.id,
        position: DOMAIN_POSITIONS[d.id] || { x: 0, y: 0 },
        data: {
          label: <DomainLabel domain={d} onlineCount={d.onlineCount} totalCount={d.nodeCount} />,
        },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        draggable: true,
        style: {
          background: d.onlineCount === d.nodeCount
            ? 'rgba(52, 211, 153, 0.08)'
            : d.onlineCount > 0 ? 'rgba(251, 191, 36, 0.08)' : 'rgba(248, 113, 113, 0.08)',
          border: `1px solid ${d.onlineCount === d.nodeCount
            ? 'rgba(52, 211, 153, 0.3)'
            : d.onlineCount > 0 ? 'rgba(251, 191, 36, 0.3)' : 'rgba(248, 113, 113, 0.3)'}`,
          borderRadius: '12px',
          padding: '4px',
        },
      })),
    [domains]
  );

  const nodeEdges: Edge[] = useMemo(
    () => [
      { id: 'cn-sv', source: 'central', target: 'silicon', animated: true, style: { stroke: 'rgba(96, 165, 250, 0.4)' } },
      { id: 'cn-tk', source: 'central', target: 'tokyo', animated: true, style: { stroke: 'rgba(96, 165, 250, 0.4)' } },
      { id: 'sv-tk', source: 'silicon', target: 'tokyo', animated: true, style: { stroke: 'rgba(167, 139, 250, 0.3)' } },
    ],
    []
  );

  const domainEdges: Edge[] = useMemo(
    () => [
      { id: 'd-cn-sv', source: 'domain-cn', target: 'domain-sv', animated: true, style: { stroke: 'rgba(96, 165, 250, 0.4)' } },
      { id: 'd-cn-tk', source: 'domain-cn', target: 'domain-tk', animated: true, style: { stroke: 'rgba(96, 165, 250, 0.4)' } },
      { id: 'd-sv-tk', source: 'domain-sv', target: 'domain-tk', animated: true, style: { stroke: 'rgba(167, 139, 250, 0.3)' } },
    ],
    []
  );

  const activeNodes = viewLevel === 'domain' ? domainFlowNodes : nodeFlowNodes;
  const activeEdges = viewLevel === 'domain' ? domainEdges : nodeEdges;

  const toggleView = useCallback(() => {
    setViewLevel(v => v === 'domain' ? 'node' : 'domain');
  }, []);

  return (
    <div className="glass-card overflow-hidden" style={{ height: '100%', minHeight: 280 }}>
      <div className="px-4 py-2 border-b border-white/[0.06] flex items-center justify-between">
        <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
          Mesh Topology
        </span>
        <button
          onClick={toggleView}
          className="text-[10px] font-mono px-2 py-0.5 rounded transition-colors"
          style={{
            color: 'var(--text-muted)',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
            cursor: 'pointer',
          }}
        >
          {viewLevel === 'domain' ? 'Node View' : 'Domain View'}
        </button>
      </div>
      <div style={{ height: 'calc(100% - 36px)' }}>
        <ReactFlow
          nodes={activeNodes}
          edges={activeEdges}
          fitView
          proOptions={{ hideAttribution: true }}
          nodesDraggable={true}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
        >
          <Background gap={20} size={1} color="rgba(255,255,255,0.03)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
