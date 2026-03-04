/**
 * FSC-Mesh Cost Controller — 成本控制层
 *
 * 预算追踪 + 模型自动降级:
 *   < 50%  → premium (claude-sonnet)
 *   50-80% → standard (doubao)
 *   > 80%  → economy (minimax)
 *   > 100% → paused (硬停止)
 *
 * Redis: HSET fsc:budget
 * 每小时自动重置 hourlySpent
 */

import type { RedisClientType } from 'redis';
import type { BudgetState, AuditEntry } from './types';
import { MODEL_TIERS } from './types';

const BUDGET_KEY = 'fsc:budget';
const BUDGET_CHANNEL = 'fsc:budget:alert';
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const DEFAULT_LIMITS = {
  hourlyLimit: 0.50,   // $0.50/h (CLAUDE.md 硬约束)
  dailyLimit: 10.0,    // $10/day
  monthlyLimit: 200.0, // $200/month
};

export class CostController {
  constructor(private redis: RedisClientType) {}

  /** 初始化预算（首次或重置） */
  async init(): Promise<void> {
    const exists = await this.redis.exists(BUDGET_KEY);
    if (!exists) {
      await this.redis.hSet(BUDGET_KEY, {
        hourlySpent: '0',
        dailySpent: '0',
        monthlySpent: '0',
        hourlyLimit: DEFAULT_LIMITS.hourlyLimit.toString(),
        dailyLimit: DEFAULT_LIMITS.dailyLimit.toString(),
        monthlyLimit: DEFAULT_LIMITS.monthlyLimit.toString(),
        currentModel: MODEL_TIERS.standard.models[0],
        modelTier: 'standard',
        lastResetHourly: Date.now().toString(),
        lastResetDaily: Date.now().toString(),
      });
    }
  }

  /** 记录一次任务的成本 */
  async recordCost(taskId: string, agentId: string, costUSD: number, tokensUsed: number): Promise<{
    tier: BudgetState['modelTier'];
    warning: boolean;
    paused: boolean;
  }> {
    // 先检查是否需要重置周期
    await this.checkReset();

    // 累加
    await this.redis.hIncrByFloat(BUDGET_KEY, 'hourlySpent', costUSD);
    await this.redis.hIncrByFloat(BUDGET_KEY, 'dailySpent', costUSD);
    await this.redis.hIncrByFloat(BUDGET_KEY, 'monthlySpent', costUSD);

    // 获取当前状态
    const state = await this.getState();
    const hourlyRatio = state.hourlySpent / state.hourlyLimit;

    // 决定模型层级
    let newTier = state.modelTier;
    if (hourlyRatio >= 1.0) {
      newTier = 'paused';
    } else if (hourlyRatio >= 0.8) {
      newTier = 'economy';
    } else if (hourlyRatio >= 0.5) {
      newTier = 'standard';
    } else {
      newTier = 'premium';
    }

    // 层级变化 → 更新 + 发布告警
    if (newTier !== state.modelTier) {
      const newModel = newTier === 'paused'
        ? 'none'
        : MODEL_TIERS[newTier].models[0];

      await this.redis.hSet(BUDGET_KEY, {
        modelTier: newTier,
        currentModel: newModel,
      });

      await this.redis.publish(BUDGET_CHANNEL, JSON.stringify({
        type: 'model_downgrade',
        from: state.modelTier,
        to: newTier,
        hourlySpent: state.hourlySpent,
        hourlyLimit: state.hourlyLimit,
        timestamp: Date.now(),
      }));
    }

    const warning = hourlyRatio >= 0.8;
    const paused = newTier === 'paused';

    return { tier: newTier, warning, paused };
  }

  /** 获取当前预算状态 */
  async getState(): Promise<BudgetState> {
    const data = await this.redis.hGetAll(BUDGET_KEY);
    return {
      hourlySpent: parseFloat(data.hourlySpent || '0'),
      dailySpent: parseFloat(data.dailySpent || '0'),
      monthlySpent: parseFloat(data.monthlySpent || '0'),
      hourlyLimit: parseFloat(data.hourlyLimit || String(DEFAULT_LIMITS.hourlyLimit)),
      dailyLimit: parseFloat(data.dailyLimit || String(DEFAULT_LIMITS.dailyLimit)),
      monthlyLimit: parseFloat(data.monthlyLimit || String(DEFAULT_LIMITS.monthlyLimit)),
      currentModel: data.currentModel || MODEL_TIERS.standard.models[0],
      modelTier: (data.modelTier as BudgetState['modelTier']) || 'standard',
      lastResetHourly: parseInt(data.lastResetHourly || '0'),
      lastResetDaily: parseInt(data.lastResetDaily || '0'),
    };
  }

  /** 获取推荐模型（基于当前预算） */
  async getRecommendedModel(): Promise<string> {
    const state = await this.getState();
    if (state.modelTier === 'paused') return 'none';
    return MODEL_TIERS[state.modelTier].models[0];
  }

  /** 是否允许新任务（预算未用完） */
  async canAcceptTask(): Promise<boolean> {
    await this.checkReset();
    const state = await this.getState();
    return state.modelTier !== 'paused';
  }

  /** 估算一个任务的成本 */
  estimateCost(tokens: number, tier: BudgetState['modelTier']): number {
    if (tier === 'paused') return 0;
    return tokens * MODEL_TIERS[tier].costPerToken;
  }

  /** 更新限额 */
  async setLimits(limits: Partial<Pick<BudgetState, 'hourlyLimit' | 'dailyLimit' | 'monthlyLimit'>>): Promise<void> {
    const fields: Record<string, string> = {};
    if (limits.hourlyLimit !== undefined) fields.hourlyLimit = limits.hourlyLimit.toString();
    if (limits.dailyLimit !== undefined) fields.dailyLimit = limits.dailyLimit.toString();
    if (limits.monthlyLimit !== undefined) fields.monthlyLimit = limits.monthlyLimit.toString();
    if (Object.keys(fields).length > 0) {
      await this.redis.hSet(BUDGET_KEY, fields);
    }
  }

  /** 获取预算利用率摘要 */
  async getSummary(): Promise<{
    hourlyUsage: number;
    dailyUsage: number;
    monthlyUsage: number;
    tier: string;
    model: string;
    canAccept: boolean;
  }> {
    const state = await this.getState();
    return {
      hourlyUsage: Math.round((state.hourlySpent / state.hourlyLimit) * 100),
      dailyUsage: Math.round((state.dailySpent / state.dailyLimit) * 100),
      monthlyUsage: Math.round((state.monthlySpent / state.monthlyLimit) * 100),
      tier: state.modelTier,
      model: state.currentModel,
      canAccept: state.modelTier !== 'paused',
    };
  }

  // ============ 内部方法 ============

  /** 检查并执行周期重置 */
  private async checkReset(): Promise<void> {
    const data = await this.redis.hGetAll(BUDGET_KEY);
    const now = Date.now();
    const lastHourly = parseInt(data.lastResetHourly || '0');
    const lastDaily = parseInt(data.lastResetDaily || '0');

    const fields: Record<string, string> = {};

    if (now - lastHourly >= HOUR_MS) {
      fields.hourlySpent = '0';
      fields.lastResetHourly = now.toString();
      // 重置后恢复模型层级
      fields.modelTier = 'standard';
      fields.currentModel = MODEL_TIERS.standard.models[0];
    }

    if (now - lastDaily >= DAY_MS) {
      fields.dailySpent = '0';
      fields.lastResetDaily = now.toString();
    }

    if (Object.keys(fields).length > 0) {
      await this.redis.hSet(BUDGET_KEY, fields);
    }
  }
}
