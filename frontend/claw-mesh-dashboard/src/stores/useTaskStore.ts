import { create } from 'zustand';
import type { QueueDepth, WorkerLoad } from '../lib/api';

// ============ 版本感知数据（P0: WS/轮询冲突解决）============
type DataSource = 'websocket' | 'polling' | 'manual';

interface VersionedQueue extends QueueDepth {
  _version: number;
  _source: DataSource;
  _ts: number;
}

interface VersionedWorkerLoad extends WorkerLoad {
  _version: number;
  _source: DataSource;
  _ts: number;
}

interface TaskState {
  queue: VersionedQueue | null;
  workerLoad: VersionedWorkerLoad | null;
  totalAgents: number;
  successRate: number;
  estimatedCost: number;
  dataVersion: number;

  updateQueue: (q: QueueDepth, source: DataSource) => void;
  updateWorkerLoad: (w: WorkerLoad, source: DataSource) => void;

  // 兼容旧接口
  setQueue: (q: QueueDepth) => void;
  setWorkerLoad: (w: WorkerLoad) => void;
  setStats: (stats: { totalAgents?: number; successRate?: number; estimatedCost?: number }) => void;
}

let globalVersion = 0;

export const useTaskStore = create<TaskState>((set, get) => ({
  queue: null,
  workerLoad: null,
  totalAgents: 0,
  successRate: 0,
  estimatedCost: 0,
  dataVersion: 0,

  updateQueue: (q, source) => {
    const current = get().queue;
    const newVersion = ++globalVersion;

    // 冲突策略：WS 优先于轮询
    if (current && source === 'polling' && current._source === 'websocket') {
      // 轮询数据 2 秒内不覆盖 WS 数据
      if (Date.now() - current._ts < 2000) {
        return;
      }
    }

    // 版本校验：不接受更旧的数据
    if (current && newVersion <= current._version) {
      return;
    }

    const total = q.completed + q.failed;
    set({
      queue: { ...q, _version: newVersion, _source: source, _ts: Date.now() },
      successRate: total > 0 ? (q.completed / total) * 100 : 0,
      dataVersion: newVersion,
    });
  },

  updateWorkerLoad: (w, source) => {
    const current = get().workerLoad;
    const newVersion = ++globalVersion;

    if (current && source === 'polling' && current._source === 'websocket') {
      if (Date.now() - current._ts < 2000) return;
    }

    if (current && newVersion <= current._version) return;

    set({
      workerLoad: { ...w, _version: newVersion, _source: source, _ts: Date.now() },
      dataVersion: newVersion,
    });
  },

  // 兼容旧接口：默认 source = polling
  setQueue: (q) => get().updateQueue(q, 'polling'),
  setWorkerLoad: (w) => get().updateWorkerLoad(w, 'polling'),

  setStats: (stats) => set((state) => ({ ...state, ...stats })),
}));
