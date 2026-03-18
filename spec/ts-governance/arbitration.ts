/**
 * FSC-Mesh Arbitration — 仲裁层（共识协议）
 *
 * 基于 ECON (ICML 2025) 贝叶斯纳什均衡 + EvoMap AI Council:
 * - 低风险: 单 Judge (质量 > 70 自动通过)
 * - 中风险: 3 Judge 多数投票
 * - 高风险: 5 Judge + 信誉 top-3 投票, ≥4/5 通过
 * - 关键: 全委员会 + 人工确认
 *
 * Redis:
 *   投票流: fsc:votes:{taskId}
 *   结果: HSET fsc:arbitration:{taskId}
 */

import type { RedisClientType } from 'redis';
import type {
  ArbitrationRequest,
  ArbitrationResult,
  Vote,
  VoteDecision,
  RiskLevel,
} from './types';
import type { TrustFactor } from './trust-factor';

const VOTE_STREAM_PREFIX = 'fsc:votes:';
const ARBITRATION_KEY_PREFIX = 'fsc:arbitration:';
const VOTE_TIMEOUT_MS = 60_000; // 60s 投票超时

// 各风险级别的投票要求
const VOTING_CONFIG: Record<RiskLevel, { required: number; threshold: number }> = {
  low:      { required: 1, threshold: 1.0 },   // 1/1 = 自动通过
  medium:   { required: 3, threshold: 0.66 },  // 2/3 多数
  high:     { required: 5, threshold: 0.80 },  // 4/5 超级多数
  critical: { required: 7, threshold: 0.86 },  // 6/7 + 人工
};

export class Arbitration {
  constructor(
    private redis: RedisClientType,
    private trustFactor: TrustFactor,
  ) {}

  /** 发起仲裁请求 */
  async requestArbitration(req: ArbitrationRequest): Promise<string> {
    const config = VOTING_CONFIG[req.riskLevel];
    req.requiredVotes = config.required;
    req.threshold = config.threshold;
    req.deadline = Date.now() + VOTE_TIMEOUT_MS;

    // 存储请求
    await this.redis.hSet(ARBITRATION_KEY_PREFIX + req.taskId, {
      type: req.type,
      riskLevel: req.riskLevel,
      requiredVotes: req.requiredVotes.toString(),
      threshold: req.threshold.toString(),
      deadline: req.deadline.toString(),
      initiator: req.initiator,
      status: 'pending',
      createdAt: Date.now().toString(),
    });

    // 低风险自动通过
    if (req.riskLevel === 'low') {
      await this.autoApprove(req.taskId);
      return req.taskId;
    }

    // 选择投票者（信誉 top-N）
    const voters = await this.trustFactor.getTopAgents(config.required);
    await this.redis.hSet(ARBITRATION_KEY_PREFIX + req.taskId, {
      selectedVoters: JSON.stringify(voters.map(v => v.agentId)),
    });

    return req.taskId;
  }

  /** 投票 */
  async castVote(taskId: string, vote: Vote): Promise<void> {
    const streamKey = VOTE_STREAM_PREFIX + taskId;
    await this.redis.xAdd(streamKey, '*', {
      voterId: vote.voterId,
      voterTrust: vote.voterTrust.toString(),
      decision: vote.decision,
      reason: vote.reason || '',
      timestamp: vote.timestamp.toString(),
    });

    // 检查是否达到法定人数
    await this.tryResolve(taskId);
  }

  /** 检查并尝试决议 */
  async tryResolve(taskId: string): Promise<ArbitrationResult | null> {
    const meta = await this.redis.hGetAll(ARBITRATION_KEY_PREFIX + taskId);
    if (!meta || meta.status !== 'pending') return null;

    const requiredVotes = parseInt(meta.requiredVotes);
    const threshold = parseFloat(meta.threshold);
    const deadline = parseInt(meta.deadline);

    // 收集投票
    const streamKey = VOTE_STREAM_PREFIX + taskId;
    const voteEntries = await this.redis.xRange(streamKey, '-', '+');
    const votes: Vote[] = voteEntries.map(e => ({
      voterId: e.message.voterId,
      voterTrust: parseFloat(e.message.voterTrust),
      decision: e.message.decision as VoteDecision,
      reason: e.message.reason || undefined,
      timestamp: parseInt(e.message.timestamp),
    }));

    // 去重（每个投票者只算最后一票）
    const latestVotes = new Map<string, Vote>();
    for (const v of votes) {
      latestVotes.set(v.voterId, v);
    }
    const uniqueVotes = Array.from(latestVotes.values());

    // 票数不够且未超时
    if (uniqueVotes.length < requiredVotes && Date.now() < deadline) {
      return null; // 继续等
    }

    // 计算结果（信誉加权投票）
    let weightedApprove = 0;
    let weightedTotal = 0;
    for (const v of uniqueVotes) {
      if (v.decision === 'abstain') continue;
      const weight = Math.max(1, v.voterTrust / 20); // 信誉越高权重越大
      weightedTotal += weight;
      if (v.decision === 'approve') weightedApprove += weight;
    }

    const approvalRate = weightedTotal > 0 ? weightedApprove / weightedTotal : 0;
    let decision: 'approved' | 'rejected' | 'escalated';

    if (uniqueVotes.length < requiredVotes) {
      // 超时且票数不够 → 升级
      decision = 'escalated';
    } else if (approvalRate >= threshold) {
      decision = 'approved';
    } else {
      decision = 'rejected';
    }

    const result: ArbitrationResult = {
      taskId,
      decision,
      votes: uniqueVotes,
      approvalRate: Math.round(approvalRate * 100) / 100,
      timestamp: Date.now(),
    };

    // 存储结果
    await this.redis.hSet(ARBITRATION_KEY_PREFIX + taskId, {
      status: decision,
      approvalRate: result.approvalRate.toString(),
      resolvedAt: Date.now().toString(),
      voteCount: uniqueVotes.length.toString(),
    });

    return result;
  }

  /** 自动通过（低风险） */
  private async autoApprove(taskId: string): Promise<void> {
    await this.redis.hSet(ARBITRATION_KEY_PREFIX + taskId, {
      status: 'approved',
      approvalRate: '1.0',
      resolvedAt: Date.now().toString(),
      voteCount: '0',
    });
  }

  /** 获取仲裁状态 */
  async getStatus(taskId: string): Promise<Record<string, string> | null> {
    const data = await this.redis.hGetAll(ARBITRATION_KEY_PREFIX + taskId);
    return Object.keys(data).length > 0 ? data : null;
  }

  /** 获取待仲裁任务列表 */
  async getPending(): Promise<string[]> {
    // 扫描所有仲裁键（生产环境应用索引优化）
    const keys: string[] = [];
    for await (const k of this.redis.scanIterator({
      MATCH: ARBITRATION_KEY_PREFIX + '*',
      COUNT: 100,
    })) {
      const key = String(k);
      const status = await this.redis.hGet(key, 'status');
      if (status === 'pending') {
        keys.push(key.replace(ARBITRATION_KEY_PREFIX, ''));
      }
    }
    return keys;
  }
}
