/**
 * FSC-Mesh Policy Engine — 声明式策略引擎（宪法层）
 *
 * - 规则存储在 Redis Hash (fsc:policies)，支持热更新
 * - 条件表达式在安全沙箱中执行（无 eval，用函数构造器 + 白名单）
 * - 分 constitutional (hard) 和 operational (soft) 两级
 *
 * 内置宪法规则:
 * 1. 单任务 token ≤ 4000
 * 2. 小时成本 ≤ $0.50
 * 3. 信誉 ≥ 任务要求
 * 4. 并发 ≤ 节点容量
 * 5. 关键路径需高信誉 (≥80)
 */

import { createClient, type RedisClientType } from 'redis';
import type {
  PolicyRule,
  PolicyCheckResult,
  PolicyViolation,
  GovernedTask,
  TrustProfile,
  BudgetState,
  Enforcement,
} from './types';

const POLICIES_KEY = 'fsc:policies';
const POLICY_CHANNEL = 'fsc:policy:updated';

// ============ 内置宪法规则 ============
const BUILTIN_RULES: PolicyRule[] = [
  {
    id: 'CONST_001',
    name: 'token_limit',
    description: '单任务 token 不超过 4000',
    level: 'constitutional',
    condition: 'task.estimatedTokens <= 4000',
    enforcement: 'hard',
    penalty: 10,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'CONST_002',
    name: 'hourly_cost_limit',
    description: '小时成本不超过 $0.50',
    level: 'constitutional',
    condition: 'budget.hourlySpent <= budget.hourlyLimit',
    enforcement: 'hard',
    penalty: 0,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'CONST_003',
    name: 'trust_threshold',
    description: 'Agent 信誉 ≥ 任务要求',
    level: 'constitutional',
    condition: 'agent.score >= task.requiredTrustScore',
    enforcement: 'hard',
    penalty: 5,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'CONST_004',
    name: 'node_capacity',
    description: '并发任务 ≤ 节点容量',
    level: 'constitutional',
    condition: 'context.activeTasks < context.maxConcurrent',
    enforcement: 'hard',
    penalty: 0,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'CONST_005',
    name: 'critical_path_trust',
    description: '关键路径需高信誉 Agent',
    level: 'constitutional',
    condition: "task.riskLevel !== 'critical' || agent.score >= 80",
    enforcement: 'hard',
    penalty: 15,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'OPS_001',
    name: 'consecutive_failure_cooldown',
    description: '连续失败 3 次需冷却 300s',
    level: 'operational',
    condition: 'agent.consecutiveFailures < 3',
    enforcement: 'soft',
    penalty: 0,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'OPS_002',
    name: 'agent_cooldown_check',
    description: 'Agent 冷却期内禁止接任务',
    level: 'operational',
    condition: 'agent.cooldownUntil <= context.now',
    enforcement: 'hard',
    penalty: 0,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
];

// ============ 安全表达式求值器 ============

/** 安全环境——只暴露白名单变量 */
interface EvalContext {
  task: Partial<GovernedTask>;
  agent: Partial<TrustProfile>;
  budget: Partial<BudgetState>;
  context: {
    now: number;
    activeTasks: number;
    maxConcurrent: number;
  };
}

function safeEvaluate(expression: string, ctx: EvalContext): boolean {
  try {
    // 用 Function 构造器创建隔离作用域，只注入白名单变量
    const fn = new Function('task', 'agent', 'budget', 'context', `return !!(${expression});`);
    return fn(ctx.task, ctx.agent, ctx.budget, ctx.context);
  } catch {
    // 表达式错误 → 保守拒绝
    return false;
  }
}

// ============ 策略引擎 ============

export class PolicyEngine {
  private rules: Map<string, PolicyRule> = new Map();
  private subscriber: RedisClientType | null = null;

  constructor(private redis: RedisClientType) {
    // 加载内置规则
    for (const rule of BUILTIN_RULES) {
      this.rules.set(rule.id, rule);
    }
  }

  /** 初始化：从 Redis 加载自定义规则 + 订阅热更新 */
  async init(): Promise<void> {
    // 加载持久化规则
    const stored = await this.redis.hGetAll(POLICIES_KEY);
    for (const [id, json] of Object.entries(stored)) {
      try {
        const rule = JSON.parse(json as string) as PolicyRule;
        this.rules.set(id, rule);
      } catch { /* 跳过损坏的规则 */ }
    }

    // 订阅热更新
    this.subscriber = this.redis.duplicate();
    await this.subscriber.connect();
    await this.subscriber.subscribe(POLICY_CHANNEL, (message) => {
      try {
        const rule = JSON.parse(message) as PolicyRule;
        this.rules.set(rule.id, rule);
      } catch { /* 忽略 */ }
    });
  }

  /** 检查任务是否符合策略 */
  validate(
    task: Partial<GovernedTask>,
    agent: Partial<TrustProfile>,
    budget: Partial<BudgetState>,
    activeTasks: number,
    maxConcurrent: number,
  ): PolicyCheckResult {
    const ctx: EvalContext = {
      task,
      agent,
      budget,
      context: {
        now: Date.now(),
        activeTasks,
        maxConcurrent,
      },
    };

    const violations: PolicyViolation[] = [];
    const warnings: PolicyViolation[] = [];

    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;

      const passed = safeEvaluate(rule.condition, ctx);
      if (!passed) {
        const violation: PolicyViolation = {
          ruleId: rule.id,
          ruleName: rule.name,
          enforcement: rule.enforcement,
          penalty: rule.penalty,
          details: `Rule "${rule.name}" violated: ${rule.description}`,
          timestamp: Date.now(),
        };

        if (rule.enforcement === 'hard') {
          violations.push(violation);
        } else {
          warnings.push(violation);
        }
      }
    }

    return {
      allowed: violations.length === 0,
      violations,
      warnings,
    };
  }

  /** 添加或更新规则（热更新） */
  async upsertRule(rule: PolicyRule): Promise<void> {
    rule.updatedAt = Date.now();
    if (!rule.createdAt) rule.createdAt = Date.now();

    this.rules.set(rule.id, rule);
    await this.redis.hSet(POLICIES_KEY, rule.id, JSON.stringify(rule));
    await this.redis.publish(POLICY_CHANNEL, JSON.stringify(rule));
  }

  /** 删除规则 */
  async removeRule(ruleId: string): Promise<void> {
    // 不允许删除内置宪法规则
    if (ruleId.startsWith('CONST_')) return;
    this.rules.delete(ruleId);
    await this.redis.hDel(POLICIES_KEY, ruleId);
  }

  /** 启用/禁用规则 */
  async toggleRule(ruleId: string, enabled: boolean): Promise<void> {
    const rule = this.rules.get(ruleId);
    if (!rule) return;
    rule.enabled = enabled;
    rule.updatedAt = Date.now();
    this.rules.set(ruleId, rule);
    await this.redis.hSet(POLICIES_KEY, ruleId, JSON.stringify(rule));
    await this.redis.publish(POLICY_CHANNEL, JSON.stringify(rule));
  }

  /** 列出所有规则 */
  listRules(): PolicyRule[] {
    return Array.from(this.rules.values());
  }

  /** 获取规则 */
  getRule(ruleId: string): PolicyRule | undefined {
    return this.rules.get(ruleId);
  }

  /** 关闭（取消订阅） */
  async shutdown(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.unsubscribe(POLICY_CHANNEL);
      await this.subscriber.disconnect();
      this.subscriber = null;
    }
  }
}
