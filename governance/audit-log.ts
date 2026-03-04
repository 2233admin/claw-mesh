/**
 * FSC-Mesh Audit Log — 治理审计日志
 *
 * Redis Stream: fsc:governance:audit
 * 保留策略: XTRIM MAXLEN ~10000
 * 所有治理决策（策略检查、信誉变更、投票、预算告警）均记录
 */

import type { RedisClientType } from 'redis';
import type { AuditEntry, AuditEventType } from './types';

const AUDIT_STREAM = 'fsc:governance:audit';
const MAX_ENTRIES = 10000;

export class AuditLog {
  constructor(private redis: RedisClientType) {}

  /** 记录审计事件 */
  async record(entry: AuditEntry): Promise<string> {
    const fields: Record<string, string> = {
      timestamp: entry.timestamp.toString(),
      eventType: entry.eventType,
      details: JSON.stringify(entry.details),
    };
    if (entry.agentId) fields.agentId = entry.agentId;
    if (entry.taskId) fields.taskId = entry.taskId;
    if (entry.policyId) fields.policyId = entry.policyId;
    if (entry.decision) fields.decision = entry.decision;
    if (entry.trustBefore !== undefined) fields.trustBefore = entry.trustBefore.toString();
    if (entry.trustAfter !== undefined) fields.trustAfter = entry.trustAfter.toString();

    const id = await this.redis.xAdd(AUDIT_STREAM, '*', fields);

    // 修剪保留最近 10000 条
    await this.redis.xTrim(AUDIT_STREAM, 'MAXLEN', MAX_ENTRIES);

    return id;
  }

  /** 快捷方法 */
  async logPolicyCheck(
    taskId: string,
    agentId: string,
    allowed: boolean,
    violations: Array<{ ruleId: string; ruleName: string }>,
  ): Promise<void> {
    await this.record({
      timestamp: Date.now(),
      eventType: allowed ? 'task_validated' : 'task_rejected',
      agentId,
      taskId,
      decision: allowed ? 'allow' : 'deny',
      details: { violations },
    });
  }

  async logTrustUpdate(
    agentId: string,
    taskId: string | undefined,
    before: number,
    after: number,
    reason: string,
  ): Promise<void> {
    await this.record({
      timestamp: Date.now(),
      eventType: 'trust_updated',
      agentId,
      taskId,
      trustBefore: before,
      trustAfter: after,
      details: { reason, delta: after - before },
    });
  }

  async logQualityCheck(
    taskId: string,
    agentId: string,
    score: number,
    decision: string,
  ): Promise<void> {
    await this.record({
      timestamp: Date.now(),
      eventType: 'quality_checked',
      agentId,
      taskId,
      decision,
      details: { score },
    });
  }

  async logBudgetWarning(spent: number, limit: number, tier: string): Promise<void> {
    await this.record({
      timestamp: Date.now(),
      eventType: spent > limit ? 'budget_exceeded' : 'budget_warning',
      details: { spent, limit, tier, ratio: Math.round((spent / limit) * 100) },
    });
  }

  /** 查询最近 N 条审计记录 */
  async getRecent(count = 50): Promise<AuditEntry[]> {
    const results = await this.redis.xRevRange(AUDIT_STREAM, '+', '-', { COUNT: count });
    return results.map(r => ({
      timestamp: parseInt(r.message.timestamp),
      eventType: r.message.eventType as AuditEventType,
      agentId: r.message.agentId,
      taskId: r.message.taskId,
      policyId: r.message.policyId,
      decision: r.message.decision,
      trustBefore: r.message.trustBefore ? parseFloat(r.message.trustBefore) : undefined,
      trustAfter: r.message.trustAfter ? parseFloat(r.message.trustAfter) : undefined,
      details: JSON.parse(r.message.details || '{}'),
    }));
  }

  /** 按 Agent 查询审计记录 */
  async getByAgent(agentId: string, count = 20): Promise<AuditEntry[]> {
    const all = await this.getRecent(500);
    return all.filter(e => e.agentId === agentId).slice(0, count);
  }

  /** 按 Task 查询审计记录 */
  async getByTask(taskId: string): Promise<AuditEntry[]> {
    const all = await this.getRecent(500);
    return all.filter(e => e.taskId === taskId);
  }

  /** 统计摘要 */
  async getSummary(): Promise<{
    total: number;
    violations: number;
    recentHour: number;
  }> {
    const total = await this.redis.xLen(AUDIT_STREAM);
    const recent = await this.getRecent(200);
    const hourAgo = Date.now() - 3600_000;
    const recentHour = recent.filter(e => e.timestamp > hourAgo).length;
    const violations = recent.filter(e =>
      e.eventType === 'policy_violation' || e.eventType === 'task_rejected'
    ).length;
    return { total, violations, recentHour };
  }
}
