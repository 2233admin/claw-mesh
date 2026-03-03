/**
 * Causal Analysis
 * 因果分析：从错误日志推断原因和修复方案
 */

const ontology = require('./ontology');

// 知识库：错误模式 → 原因 + 修复方案
const KNOWLEDGE_BASE = [
  {
    pattern: /OOM|out of memory|killed process/i,
    cause: '容器OOM',
    fix: '--memory=2g',
    confidence: 93
  },
  {
    pattern: /ECONNREFUSED|connection refused/i,
    cause: '服务未启动',
    fix: 'docker-compose up -d',
    confidence: 90
  },
  {
    pattern: /ENOENT|no such file/i,
    cause: '文件不存在',
    fix: '检查文件路径',
    confidence: 85
  },
  {
    pattern: /timeout|timed out/i,
    cause: '超时',
    fix: '增加 timeout 参数',
    confidence: 80
  },
  {
    pattern: /permission denied/i,
    cause: '权限不足',
    fix: 'chmod +x 或 sudo',
    confidence: 88
  },
  {
    pattern: /port.*already in use/i,
    cause: '端口占用',
    fix: 'lsof -ti:PORT | xargs kill',
    confidence: 92
  },
  {
    pattern: /SIGTERM|SIGKILL/i,
    cause: '进程被强制终止',
    fix: '检查资源限制',
    confidence: 75
  }
];

/**
 * 诊断失败原因
 */
function diagnoseFailure(storyId, errorLog) {
  if (!errorLog || typeof errorLog !== 'string') {
    return {
      story_id: storyId,
      cause: '未知错误',
      fix: '查看完整日志',
      confidence: 50,
      timestamp: Date.now()
    };
  }
  
  // 匹配知识库
  for (const rule of KNOWLEDGE_BASE) {
    if (rule.pattern.test(errorLog)) {
      const finding = {
        story_id: storyId,
        cause: rule.cause,
        fix: rule.fix,
        confidence: rule.confidence,
        error_log: errorLog.substring(0, 200),
        timestamp: Date.now()
      };
      
      // 记录到本体图
      const errorEntity = ontology.addEntity({
        name: rule.cause,
        category: 'error',
        attributes: {
          story_id: storyId,
          pattern: rule.pattern.source
        }
      });
      
      const fixEntity = ontology.addEntity({
        name: rule.fix,
        category: 'fix',
        attributes: {
          confidence: rule.confidence
        }
      });
      
      ontology.addRelation({
        from: errorEntity.id,
        to: fixEntity.id,
        relation_type: 'fixes',
        confidence: rule.confidence / 100
      });
      
      return finding;
    }
  }
  
  // 未匹配到规则
  return {
    story_id: storyId,
    cause: '未知错误',
    fix: '查看完整日志',
    confidence: 50,
    error_log: errorLog.substring(0, 200),
    timestamp: Date.now()
  };
}

/**
 * 从成功中学习
 */
function learnFromSuccess(storyId, fixDescription) {
  const successEntity = ontology.addEntity({
    name: `Success: ${storyId}`,
    category: 'success',
    attributes: {
      story_id: storyId,
      fix: fixDescription,
      timestamp: Date.now()
    }
  });
  
  // 如果有之前的失败记录，建立关系
  const errors = ontology.query({ 
    type: 'entity', 
    category: 'error' 
  }).filter(e => e.attributes.story_id === storyId);
  
  for (const error of errors) {
    ontology.addRelation({
      from: error.id,
      to: successEntity.id,
      relation_type: 'resolved_by',
      confidence: 1.0
    });
  }
  
  return successEntity;
}

/**
 * 获取因果链
 */
function getCausalChain(errorId) {
  const relations = ontology.query({ 
    type: 'relation',
    from: errorId
  });
  
  const chain = [];
  
  for (const rel of relations) {
    const target = ontology.query({ 
      type: 'entity',
      id: rel.to
    })[0];
    
    if (target) {
      chain.push({
        relation: rel.relation_type,
        entity: target,
        confidence: rel.confidence
      });
    }
  }
  
  return chain;
}

module.exports = {
  diagnoseFailure,
  learnFromSuccess,
  getCausalChain
};
