import { create } from 'zustand';

export interface MeshEvent {
  id: string;
  timestamp: number;
  type: string;
  agentId: string;
  node: string;
  status: 'success' | 'failure' | 'pending' | 'info';
  message?: string;
  version?: number;
}

interface EventState {
  events: MeshEvent[];
  maxEvents: number;
  latestVersion: number;

  addEvent: (event: MeshEvent) => void;
  addEvents: (events: MeshEvent[]) => void;
  clearEvents: () => void;
}

let eventVersion = 0;

export const useEventStore = create<EventState>((set) => ({
  events: [],
  maxEvents: 200,
  latestVersion: 0,

  addEvent: (event) => {
    const ver = ++eventVersion;
    set((state) => ({
      events: [{ ...event, version: ver }, ...state.events].slice(0, state.maxEvents),
      latestVersion: ver,
    }));
  },

  addEvents: (events) => {
    const tagged = events.map(e => ({ ...e, version: ++eventVersion }));
    set((state) => ({
      events: [...tagged, ...state.events].slice(0, state.maxEvents),
      latestVersion: eventVersion,
    }));
  },

  clearEvents: () => set({ events: [] }),
}));
