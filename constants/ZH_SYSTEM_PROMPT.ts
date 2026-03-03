/**
 * 中文系统 Prompt 模板
 * 
 * 功能：
 * - 根因分析
 * - 证据收集
 * - 步骤推理
 * - 置信度评估
 * - 强制 JSON Schema 输出
 */

export const ZH_SYSTEM_PROMPT = `你是一个专业的技术问题分析助手。请严格按照以下 JSON Schema 格式输出：

{
  "root_cause": "问题的根本原因（1-2 句话）",
  "evidence": [
    "证据 1：具体的日志、指标或现象",
    "证据 2：...",
    "证据 3：..."
  ],
  "steps": [
    {
      "step": 1,
      "action": "具体操作步骤",
      "expected": "预期结果",
      "risk": "潜在风险（如果有）"
    }
  ],
  "confidence": 0.95,
  "reasoning": "推理过程（2-3 句话）"
}

**重要规则：**
1. 必须输出有效的 JSON 格式
2. 不要添加任何 Markdown 代码块标记（如 \`\`\`json）
3. 不要添加任何解释性文字
4. 所有字段都必须存在
5. confidence 必须是 0-1 之间的数字
6. steps 至少包含 1 个步骤

**示例输出：**
{
  "root_cause": "Redis PEL 积压导致任务重复执行",
  "evidence": [
    "redis-cli XINFO GROUP 显示 pending=127",
    "Worker 日志出现重复的 task_id",
    "CPU 使用率异常升高至 85%"
  ],
  "steps": [
    {
      "step": 1,
      "action": "执行 XAUTOCLAIM 清理僵尸消息",
      "expected": "pending 降至 0",
      "risk": "可能导致部分任务重新执行"
    },
    {
      "step": 2,
      "action": "添加 cron 定时清理脚本",
      "expected": "pending 持续保持在 10 以下",
      "risk": "无"
    }
  ],
  "confidence": 0.92,
  "reasoning": "根据 Redis 监控数据和 Worker 日志，确认是 PEL 积压导致。XAUTOCLAIM 是官方推荐的清理方案，风险可控。"
}`;

export const ZH_USER_PROMPT_TEMPLATE = (problem: string) => `
请分析以下问题：

${problem}

请严格按照系统提示中的 JSON Schema 格式输出分析结果。
`;

// JSON 输出校验
export function validateJSONOutput(output: string): boolean {
  try {
    const parsed = JSON.parse(output);
    
    // 检查必需字段
    const requiredFields = ['root_cause', 'evidence', 'steps', 'confidence', 'reasoning'];
    for (const field of requiredFields) {
      if (!(field in parsed)) {
        console.error(`Missing required field: ${field}`);
        return false;
      }
    }
    
    // 检查类型
    if (typeof parsed.root_cause !== 'string') return false;
    if (!Array.isArray(parsed.evidence)) return false;
    if (!Array.isArray(parsed.steps)) return false;
    if (typeof parsed.confidence !== 'number') return false;
    if (parsed.confidence < 0 || parsed.confidence > 1) return false;
    if (typeof parsed.reasoning !== 'string') return false;
    
    // 检查 steps 结构
    for (const step of parsed.steps) {
      if (!step.step || !step.action || !step.expected) {
        console.error('Invalid step structure');
        return false;
      }
    }
    
    return true;
  } catch (error) {
    console.error('JSON parse error:', error);
    return false;
  }
}

// 强制重试（非 JSON 输出）
export async function retryUntilValidJSON(
  callLLM: () => Promise<string>,
  maxRetries = 3
): Promise<any> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const output = await callLLM();
    
    // 尝试清理输出（移除 Markdown 代码块）
    const cleaned = output
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    
    if (validateJSONOutput(cleaned)) {
      return JSON.parse(cleaned);
    }
    
    console.warn(`[Retry ${attempt + 1}/${maxRetries}] Invalid JSON output, retrying...`);
  }
  
  throw new Error('Failed to get valid JSON output after retries');
}
