#!/usr/bin/env bun
/**
 * CLAW Mesh Gateway GitHub Integration
 * 
 * 深度整合 github skill
 * 
 * 功能：
 * - 任务完成后自动创建 PR
 * - PR 关联任务、添加评论
 * - 支持 PR 模板
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import winston from 'winston';

const execAsync = promisify(exec);

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
    new winston.transports.File({ filename: 'github-integration.log' })
  ]
});

// ============ GitHub 集成器 ============
class GitHubIntegration {
  private repoOwner: string;
  private repoName: string;
  private baseBranch: string;

  constructor(repoOwner: string, repoName: string, baseBranch = 'main') {
    this.repoOwner = repoOwner;
    this.repoName = repoName;
    this.baseBranch = baseBranch;
  }

  /**
   * 自动创建 PR
   */
  async createPullRequest(
    taskId: string,
    taskType: string,
    headBranch: string,
    title?: string,
    body?: string
  ) {
    logger.info(`[GitHub] 创建 PR: task=${taskId}, branch=${headBranch}`);

    try {
      // 1. 生成 PR 标题和内容
      const prTitle = title || `[CLAW-Mesh] ${taskType}: ${taskId}`;
      const prBody = body || this._generatePRBody(taskId, taskType, headBranch);

      // 2. 使用 gh CLI 创建 PR
      const { stdout } = await execAsync(
        `gh pr create --title "${prTitle}" --body "${prBody}" --head ${headBranch} --base ${this.baseBranch}`,
        { cwd: process.cwd() }
      );

      const prUrl = stdout.trim();
      logger.info(`[GitHub] PR 创建成功: ${prUrl}`);

      // 3. 添加评论（关联任务）
      await this._addPRComment(prUrl, `关联任务: ${taskId}\n\n由 CLAW Mesh FSC Gateway 自动创建`);

      return { prUrl, prTitle, prBody };
    } catch (error) {
      logger.error(`[GitHub] PR 创建失败:`, error);
      throw error;
    }
  }

  /**
   * 添加 PR 评论
   */
  private async _addPRComment(prUrl: string, comment: string) {
    try {
      const prNumber = prUrl.split('/').pop();
      if (!prNumber) return;

      await execAsync(
        `gh pr comment ${prNumber} --body "${comment}"`,
        { cwd: process.cwd() }
      );
      logger.info(`[GitHub] 评论添加成功: PR #${prNumber}`);
    } catch (error) {
      logger.error(`[GitHub] 评论添加失败:`, error);
    }
  }

  /**
   * 生成 PR 内容模板
   */
  private _generatePRBody(taskId: string, taskType: string, headBranch: string) {
    return `## CLAW Mesh 自动 PR

### 任务信息
- **任务 ID**: ${taskId}
- **任务类型**: ${taskType}
- **分支**: ${headBranch}
- **创建时间**: ${new Date().toISOString()}

### 变更描述
（请在此处填写变更描述）

### 测试
- [ ] 本地测试通过
- [ ] 部署测试通过

### 关联
- 任务: ${taskId}
- CLAW Mesh Gateway: 自动创建

---
由 CLAW Mesh FSC Gateway 自动生成`;
  }
}

export { GitHubIntegration };
