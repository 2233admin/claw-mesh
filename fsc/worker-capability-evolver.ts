#!/usr/bin/env bun
/**
 * CLAW Mesh Worker Capability Evolver
 * 
 * 深度整合 capability-evolver + self-improving-agent
 * 
 * 功能：
 * - 任务完成后分析能力使用情况
 * - 错误时捕获并固化经验
 * - 成功时提取最佳实践
 * - 存入 MemoV 知识图谱 + 因果链
 */

import { Ontology } from '../memov/ontology';
import { CausalAnalyzer } from '../memov/causal';
import winston from 'winston';

// ============ Logger ============
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ filename: 'capability-evolver.log' })
  ]
});

// ============ 能力分析器 ============
class CapabilityEvolver {
  private ontology: Ontology;
  private causal: CausalAnalyzer;
  private nodeId: string;

  constructor(nodeId: string) {
    this.nodeId = nodeId;
    this.ontology = new Ontology();
    this.causal = new CausalAnalyzer();
  }

  /**
   * 分析任务执行并演进能力
   */
  async analyzeAndEvolve(
    taskId: string,
    taskType: string,
    outcome: 'success' | 'failure',
    context: {
      commands?: string[];
      output?: string;
      error?: string;
      durationMs?: number;
    }
  ) {
    logger.info(`[CapabilityEvolver] 分析任务: ${taskId}, 结果: ${outcome}`);

    // 1. 添加事件到因果分析器
    this.causal.addEvent(taskId, taskType, outcome, context);

    // 2. 能力分析
    const capabilities = this._extractCapabilities(taskType, context);

    // 3. 存入知识图谱
    for (const cap of capabilities) {
      this.ontology.addEntity(
        `cap:${cap.name}:${this.nodeId}`,
        'Capability',
        {
          name: cap.name,
          nodeId: this.nodeId,
          taskId,
          outcome,
          confidence: cap.confidence,
          lastUsed: Date.now()
        }
      );

      this.ontology.addRelation(
        `node:${this.nodeId}`,
        `cap:${cap.name}:${this.nodeId}`,
        'HAS_CAPABILITY',
        { taskId, outcome }
      );
    }

    // 4. 因果分析（失败时）
    if (outcome === 'failure') {
      const chain = this.causal.rootCauseAnalysis(taskId);
      logger.info(`[CapabilityEvolver] 因果链:`, chain);

      // 存入知识图谱
      if (chain) {
        for (const step of chain) {
          this.ontology.addEntity(
            `cause:${taskId}:${step.level}`,
            'RootCause',
            {
              taskId,
              level: step.level,
              why: step.why,
              evidence: step.evidence
            }
          );

          this.ontology.addRelation(
            `task:${taskId}`,
            `cause:${taskId}:${step.level}`,
            'HAS_CAUSE',
            {}
          );
        }
      }
    }

    // 5. 成功归因（成功时）
    if (outcome === 'success') {
      const attribution = this.causal.successAttribution(taskId);
      logger.info(`[CapabilityEvolver] 成功归因:`, attribution);

      if (attribution) {
        for (const factor of attribution.keyFactors) {
          this.ontology.addEntity(
            `factor:${taskId}:${factor}`,
            'SuccessFactor',
            { taskId, factor }
          );

          this.ontology.addRelation(
            `task:${taskId}`,
            `factor:${taskId}:${factor}`,
            'HAS_SUCCESS_FACTOR',
            {}
          );
        }
      }
    }

    logger.info(`[CapabilityEvolver] 分析完成: ${taskId}`);
    return { capabilities, outcome };
  }

  /**
   * 从任务中提取能力
   */
  private _extractCapabilities(taskType: string, context: any) {
    const capabilities: Array<{ name: string; confidence: number }> = [];

    // 简单规则匹配（后续可优化为向量分类）
    if (context.commands?.some((cmd: string) => cmd.includes('git'))) {
      capabilities.push({ name: 'git_operations', confidence: 0.9 });
    }
    if (context.commands?.some((cmd: string) => cmd.includes('docker'))) {
      capabilities.push({ name: 'docker_operations', confidence: 0.9 });
    }
    if (context.commands?.some((cmd: string) => cmd.includes('npm') || cmd.includes('bun'))) {
      capabilities.push({ name: 'package_management', confidence: 0.85 });
    }
    if (taskType.includes('verify') || taskType.includes('test')) {
      capabilities.push({ name: 'validation', confidence: 0.9 });
    }
    if (taskType.includes('build') || taskType.includes('compile')) {
      capabilities.push({ name: 'build_automation', confidence: 0.9 });
    }

    // 默认能力
    if (capabilities.length === 0) {
      capabilities.push({ name: 'general_task_execution', confidence: 0.7 });
    }

    return capabilities;
  }
}

export { CapabilityEvolver };
