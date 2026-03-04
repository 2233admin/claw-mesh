import { create } from 'zustand';
import type { HealthData, TopologyData, NodeId } from '../lib/api';

// ============ 版本感知（P0: 冲突解决）============
type DataSource = 'websocket' | 'polling' | 'manual';

interface NodeStatus {
  id: NodeId;
  label: string;
  ip: string;
  health: HealthData | null;
  online: boolean;
  lastCheck: number;
  _version: number;
  _source: DataSource;
}

interface MeshState {
  nodes: Record<NodeId, NodeStatus>;
  topology: TopologyData | null;

  setNodeHealth: (node: NodeId, health: HealthData | null, source?: DataSource) => void;
  setTopology: (topo: TopologyData) => void;
}

let nodeVersion = 0;

export const useMeshStore = create<MeshState>((set, get) => ({
  nodes: {
    central: { id: 'central', label: 'CN 中央', ip: '10.10.0.1', health: null, online: false, lastCheck: 0, _version: 0, _source: 'polling' },
    silicon: { id: 'silicon', label: 'SV 硅谷', ip: '10.10.0.2', health: null, online: false, lastCheck: 0, _version: 0, _source: 'polling' },
    tokyo:   { id: 'tokyo',   label: 'TK 东京', ip: '10.10.0.3', health: null, online: false, lastCheck: 0, _version: 0, _source: 'polling' },
  },
  topology: null,

  setNodeHealth: (node, health, source = 'polling') => {
    const current = get().nodes[node];
    const newVer = ++nodeVersion;

    // WS 优先：轮询在 2s 内不覆盖 WS 数据
    if (current && source === 'polling' && current._source === 'websocket') {
      if (Date.now() - current.lastCheck < 2000) return;
    }

    set((state) => ({
      nodes: {
        ...state.nodes,
        [node]: {
          ...state.nodes[node],
          health,
          online: health !== null,
          lastCheck: Date.now(),
          _version: newVer,
          _source: source,
        },
      },
    }));
  },

  setTopology: (topo) => set({ topology: topo }),
}));
