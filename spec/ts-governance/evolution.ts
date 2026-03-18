/**
 * FSC-Mesh Evolution — Agent 进化层（GEP 协议整合）
 *
 * 映射 EvoMap evolver 概念:
 *   Capsule → 可复用知识包 (存 Pointer Memory)
 *   Gene    → Agent 行为特征向量
 *   Strategy Presets → 探索/利用平衡
 *
 * 策略预设:
 *   balanced:    exploration=30%, exploitation=70%
 *   innovate:    exploration=60%, exploitation=40%
 *   harden:      exploration=10%, exploitation=90%
 *   repair-only: exploration=0%,  exploitation=100%
 *   auto:        动态调整（基于近 100 任务成功率）
 *
 * 反收敛检测:
 *   diversity_index < 0.3 持续 50 任务 → 切换 innovate
 */

import type { RedisClientType } from 'redis';
import type { EvolutionStrategy, EvolutionState } from './types';

const EVOLUTION_KEY = 'fsc:evolution';
const CAPSULE_KEY_PREFIX = 'fsc:capsule:';
const EVOLUTION_CHANNEL = 'fsc:evolution:strategy';
const TASK_HISTORY_KEY = 'fsc:evolution:task_history';
const MAX_HISTORY = 200;

const STRATEGY_PRESETS: Record<Exclude<EvolutionStrategy, 'auto'>, { exploration: number }> = {
  balanced:      { exploration: 0.30 },
  innovate:      { exploration: 0.60 },
  harden:        { exploration: 0.10 },
  'repair-only': { exploration: 0.00 },
};

// 自动策略阈值
const AUTO_THRESHOLDS = {
  highSuccess: 0.85,    // 成功率 > 85% → harden
  lowSuccess: 0.50,     // 成功率 < 50% → repair-only
  mediumHigh: 0.70,     // 成功率 > 70% → balanced
  // 其余 → innovate
};

const CONVERGENCE_THRESHOLD = 0.3;
const CONVERGENCE_WINDOW = 50;

export interface Capsule {
  slug: string;
  version: number;
  content: string;         // 知识内容
  agentId: string;         // 发现者
  qualityScore: number;    // 质量分
  useCount: number;        // 被引用次数
  createdAt: number;
}

export interface TaskOutcome {
  taskId: string;
  agentId: string;
  success: boolean;
  qualityScore: number;
  touchedFiles: string[];  // 用于计算多样性
  approach: string;        // 方案描述（用于去重/相似度）
  timestamp: number;
}

export class Evolution {
  constructor(private redis: RedisClientType) {}

  /** 初始化进化状态 */
  async init(): Promise<void> {
    const exists = await this.redis.exists(EVOLUTION_KEY);
    if (!exists) {
      await this.redis.hSet(EVOLUTION_KEY, {
        strategy: 'balanced',
        explorationRate: '0.30',
        diversityIndex: '1.0',
        recentSuccessRate: '0.5',
        capsuleCount: '0',
        lastEvaluatedAt: Date.now().toString(),
      });
    }
  }

  /** 获取当前进化状态 */
  async getState(): Promise<EvolutionState> {
    const data = await this.redis.hGetAll(EVOLUTION_KEY);
    return {
      strategy: (data.strategy as EvolutionStrategy) || 'balanced',
      explorationRate: parseFloat(data.explorationRate || '0.30'),
      diversityIndex: parseFloat(data.diversityIndex || '1.0'),
      recentSuccessRate: parseFloat(data.recentSuccessRate || '0.5'),
      capsuleCount: parseInt(data.capsuleCount || '0'),
      lastEvaluatedAt: parseInt(data.lastEvaluatedAt || '0'),
    };
  }

  /** 手动设置策略 */
  async setStrategy(strategy: EvolutionStrategy): Promise<void> {
    const exploration = strategy === 'auto'
      ? (await this.calculateAutoExploration())
      : STRATEGY_PRESETS[strategy].exploration;

    await this.redis.hSet(EVOLUTION_KEY, {
      strategy,
      explorationRate: exploration.toString(),
      lastEvaluatedAt: Date.now().toString(),
    });

    await this.redis.publish(EVOLUTION_CHANNEL, JSON.stringify({
      strategy,
      explorationRate: exploration,
      timestamp: Date.now(),
    }));
  }

  /** 记录任务结果 + 触发自动评估 */
  async recordOutcome(outcome: TaskOutcome): Promise<void> {
    // 追加到历史
    await this.redis.xAdd(TASK_HISTORY_KEY, '*', {
      taskId: outcome.taskId,
      agentId: outcome.agentId,
      success: outcome.success ? '1' : '0',
      qualityScore: outcome.qualityScore.toString(),
      touchedFiles: JSON.stringify(outcome.touchedFiles),
      approach: outcome.approach,
      timestamp: outcome.timestamp.toString(),
    });

    // 修剪历史
    await this.redis.xTrim(TASK_HISTORY_KEY, 'MAXLEN', MAX_HISTORY);

    // 每 10 个任务评估一次
    const len = await this.redis.xLen(TASK_HISTORY_KEY);
    if (len % 10 === 0) {
      await this.evaluate();
    }
  }

  /** 评估并可能调整策略 */
  async evaluate(): Promise<EvolutionState> {
    const state = await this.getState();
    const history = await this.getRecentHistory(100);

    if (history.length < 10) return state; // 数据不够，跳过

    // 计算成功率
    const successCount = history.filter(h => h.success).length;
    const successRate = successCount / history.length;

    // 计算多样性指数 (Shannon entropy on file patterns)
    const diversityIndex = this.calculateDiversity(history);

    // 更新指标
    await this.redis.hSet(EVOLUTION_KEY, {
      recentSuccessRate: successRate.toFixed(4),
      diversityIndex: diversityIndex.toFixed(4),
      lastEvaluatedAt: Date.now().toString(),
    });

    // auto 模式下自动调整策略
    if (state.strategy === 'auto') {
      const newExploration = await this.calculateAutoExploration(successRate, diversityIndex);
      await this.redis.hSet(EVOLUTION_KEY, {
        explorationRate: newExploration.toFixed(4),
      });
    }

    // 反收敛检测（任何模式）
    if (diversityIndex < CONVERGENCE_THRESHOLD && history.length >= CONVERGENCE_WINDOW) {
      const recentDiversity = this.calculateDiversity(history.slice(-CONVERGENCE_WINDOW));
      if (recentDiversity < CONVERGENCE_THRESHOLD && state.strategy !== 'innovate') {
        await this.setStrategy('innovate');
      }
    }

    return this.getState();
  }

  // ============ Capsule 管理 ============

  /** 创建知识 Capsule */
  async createCapsule(capsule: Capsule): Promise<string> {
    const key = `${CAPSULE_KEY_PREFIX}${capsule.slug}@v${capsule.version}`;
    await this.redis.hSet(key, {
      slug: capsule.slug,
      version: capsule.version.toString(),
      content: capsule.content,
      agentId: capsule.agentId,
      qualityScore: capsule.qualityScore.toString(),
      useCount: '0',
      createdAt: capsule.createdAt.toString(),
    });

    await this.redis.hIncrBy(EVOLUTION_KEY, 'capsuleCount', 1);
    return `ptr://evolution/capsule/${capsule.slug}@v${capsule.version}`;
  }

  /** 获取 Capsule */
  async getCapsule(slug: string, version?: number): Promise<Capsule | null> {
    // 如果没指定版本，找最新
    if (version === undefined) {
      version = await this.getLatestCapsuleVersion(slug);
      if (version === 0) return null;
    }

    const key = `${CAPSULE_KEY_PREFIX}${slug}@v${version}`;
    const data = await this.redis.hGetAll(key);
    if (!data || !data.slug) return null;

    // 增加引用计数
    await this.redis.hIncrBy(key, 'useCount', 1);

    return {
      slug: data.slug,
      version: parseInt(data.version),
      content: data.content,
      agentId: data.agentId,
      qualityScore: parseFloat(data.qualityScore),
      useCount: parseInt(data.useCount) + 1,
      createdAt: parseInt(data.createdAt),
    };
  }

  /** 判断当前任务应该探索还是利用 */
  async shouldExplore(): Promise<boolean> {
    const state = await this.getState();
    return Math.random() < state.explorationRate;
  }

  // ============ 内部方法 ============

  private async getRecentHistory(count: number): Promise<TaskOutcome[]> {
    const entries = await this.redis.xRevRange(TASK_HISTORY_KEY, '+', '-', { COUNT: count });
    return entries.map(e => ({
      taskId: e.message.taskId,
      agentId: e.message.agentId,
      success: e.message.success === '1',
      qualityScore: parseFloat(e.message.qualityScore),
      touchedFiles: JSON.parse(e.message.touchedFiles || '[]'),
      approach: e.message.approach || '',
      timestamp: parseInt(e.message.timestamp),
    }));
  }

  /** Shannon diversity on file patterns */
  private calculateDiversity(outcomes: TaskOutcome[]): number {
    if (outcomes.length === 0) return 1.0;

    // 统计每个文件路径目录的频率
    const dirCounts = new Map<string, number>();
    let total = 0;
    for (const o of outcomes) {
      for (const f of o.touchedFiles) {
        const dir = f.split('/').slice(0, -1).join('/') || '/';
        dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
        total++;
      }
    }

    if (total === 0) return 1.0;

    // Shannon entropy
    let entropy = 0;
    for (const count of dirCounts.values()) {
      const p = count / total;
      if (p > 0) entropy -= p * Math.log2(p);
    }

    // 归一化到 0-1
    const maxEntropy = Math.log2(Math.max(dirCounts.size, 1));
    return maxEntropy > 0 ? entropy / maxEntropy : 1.0;
  }

  private async calculateAutoExploration(
    successRate?: number,
    diversityIndex?: number,
  ): Promise<number> {
    if (successRate === undefined) {
      const state = await this.getState();
      successRate = state.recentSuccessRate;
      diversityIndex = state.diversityIndex;
    }

    // 低多样性 → 提高探索
    const diversityFactor = (diversityIndex ?? 1.0) < CONVERGENCE_THRESHOLD ? 0.2 : 0;

    if (successRate >= AUTO_THRESHOLDS.highSuccess) {
      return 0.10 + diversityFactor; // harden + 反收敛补偿
    } else if (successRate < AUTO_THRESHOLDS.lowSuccess) {
      return 0.00 + diversityFactor; // repair-only + 反收敛补偿
    } else if (successRate >= AUTO_THRESHOLDS.mediumHigh) {
      return 0.30 + diversityFactor; // balanced + 反收敛补偿
    } else {
      return 0.60; // innovate
    }
  }

  private async getLatestCapsuleVersion(slug: string): Promise<number> {
    let maxVersion = 0;
    for await (const k of this.redis.scanIterator({
      MATCH: `${CAPSULE_KEY_PREFIX}${slug}@v*`,
      COUNT: 50,
    })) {
      const key = String(k);
      const match = key.match(/@v(\d+)$/);
      if (match) {
        const v = parseInt(match[1]);
        if (v > maxVersion) maxVersion = v;
      }
    }
    return maxVersion;
  }
}
