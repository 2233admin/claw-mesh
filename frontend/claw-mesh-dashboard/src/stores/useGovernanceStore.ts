import { create } from 'zustand';

export interface TrustEntry {
  agentId: string;
  score: number;
  totalTasks: number;
  successRate: number;
  avgQuality: number;
  cooldown: boolean;
}

export interface AuditEntry {
  id: string;
  timestamp: number;
  eventType: string;
  agentId?: string;
  taskId?: string;
  decision?: string;
  details: string;
}

export interface BudgetState {
  hourlyUsage: number;
  dailyUsage: number;
  monthlyUsage: number;
  tier: string;
  model: string;
  canAccept: boolean;
}

export interface PolicyRule {
  id: string;
  name: string;
  level: string;
  enforcement: string;
  enabled: boolean;
}

export interface QualitySummary {
  total: number;
  approved: number;
  review: number;
  rejected: number;
  avgScore: number;
}

export interface FreeEndpointStatus {
  id: string;
  provider: 'openrouter' | 'nvidia-nim' | 'custom';
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  addedAt: number;
  circuit: {
    status: 'closed' | 'open' | 'half-open';
    failures: number;
    lastFailure: number;
    lastSuccess: number;
    totalRequests: number;
    totalFailures: number;
  };
}

export interface FreeProviderSummary {
  total: number;
  healthy: number;
  open: number;
  halfOpen: number;
}

interface GovernanceState {
  trustLeaderboard: TrustEntry[];
  auditLog: AuditEntry[];
  budget: BudgetState;
  policies: PolicyRule[];
  quality: QualitySummary;
  evolutionStrategy: string;
  diversityIndex: number;
  freeProviders: FreeEndpointStatus[];
  freeProviderSummary: FreeProviderSummary;

  setTrustLeaderboard: (entries: TrustEntry[]) => void;
  addAuditEntries: (entries: AuditEntry[]) => void;
  setBudget: (budget: BudgetState) => void;
  setPolicies: (rules: PolicyRule[]) => void;
  setQuality: (q: QualitySummary) => void;
  setEvolution: (strategy: string, diversity: number) => void;
  setFreeProviders: (endpoints: FreeEndpointStatus[], summary: FreeProviderSummary) => void;
}

export const useGovernanceStore = create<GovernanceState>((set) => ({
  trustLeaderboard: [],
  auditLog: [],
  budget: { hourlyUsage: 0, dailyUsage: 0, monthlyUsage: 0, tier: 'standard', model: 'doubao', canAccept: true },
  policies: [],
  quality: { total: 0, approved: 0, review: 0, rejected: 0, avgScore: 0 },
  evolutionStrategy: 'balanced',
  diversityIndex: 1.0,
  freeProviders: [],
  freeProviderSummary: { total: 0, healthy: 0, open: 0, halfOpen: 0 },

  setTrustLeaderboard: (entries) => set({ trustLeaderboard: entries }),
  addAuditEntries: (entries) => set((s) => ({
    auditLog: [...entries, ...s.auditLog].slice(0, 200),
  })),
  setBudget: (budget) => set({ budget }),
  setPolicies: (policies) => set({ policies }),
  setQuality: (quality) => set({ quality }),
  setEvolution: (strategy, diversity) => set({ evolutionStrategy: strategy, diversityIndex: diversity }),
  setFreeProviders: (endpoints, summary) => set({ freeProviders: endpoints, freeProviderSummary: summary }),
}));
