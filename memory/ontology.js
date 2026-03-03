/**
 * Ontology Graph Management
 * 本体图管理：实体、关系、推理
 */

const fs = require('fs');
const path = require('path');

const ONTOLOGY_DIR = path.join(__dirname, '../.mem/ontology');
const GRAPH_FILE = path.join(ONTOLOGY_DIR, 'graph.jsonl');

// 确保目录存在
function ensureDir() {
  if (!fs.existsSync(ONTOLOGY_DIR)) {
    fs.mkdirSync(ONTOLOGY_DIR, { recursive: true });
  }
}

/**
 * 添加实体到本体图
 */
function addEntity(entity) {
  ensureDir();
  
  const record = {
    type: 'entity',
    id: entity.id || `entity-${Date.now()}`,
    name: entity.name,
    category: entity.category,
    attributes: entity.attributes || {},
    timestamp: Date.now()
  };
  
  fs.appendFileSync(GRAPH_FILE, JSON.stringify(record) + '\n');
  return record;
}

/**
 * 添加关系到本体图
 */
function addRelation(relation) {
  ensureDir();
  
  const record = {
    type: 'relation',
    id: relation.id || `relation-${Date.now()}`,
    from: relation.from,
    to: relation.to,
    relation_type: relation.relation_type,
    confidence: relation.confidence || 1.0,
    timestamp: Date.now()
  };
  
  fs.appendFileSync(GRAPH_FILE, JSON.stringify(record) + '\n');
  return record;
}

/**
 * 查询本体图
 */
function query(filter = {}) {
  ensureDir();
  
  if (!fs.existsSync(GRAPH_FILE)) {
    return [];
  }
  
  const lines = fs.readFileSync(GRAPH_FILE, 'utf-8').split('\n').filter(Boolean);
  const records = lines.map(line => JSON.parse(line));
  
  // 应用过滤器
  let results = records;
  
  if (filter.type) {
    results = results.filter(r => r.type === filter.type);
  }
  
  if (filter.category) {
    results = results.filter(r => r.category === filter.category);
  }
  
  if (filter.relation_type) {
    results = results.filter(r => r.relation_type === filter.relation_type);
  }
  
  if (filter.id) {
    results = results.filter(r => r.id === filter.id);
  }
  
  return results;
}

/**
 * 推理：根据已知关系推断新关系
 */
function infer() {
  const entities = query({ type: 'entity' });
  const relations = query({ type: 'relation' });
  
  const inferred = [];
  
  // 简单推理规则：传递性
  // 如果 A causes B, B causes C, 则推断 A causes C
  for (const r1 of relations) {
    if (r1.relation_type === 'causes') {
      for (const r2 of relations) {
        if (r2.relation_type === 'causes' && r1.to === r2.from) {
          // 检查是否已存在
          const exists = relations.some(r => 
            r.from === r1.from && 
            r.to === r2.to && 
            r.relation_type === 'causes'
          );
          
          if (!exists) {
            inferred.push({
              from: r1.from,
              to: r2.to,
              relation_type: 'causes',
              confidence: Math.min(r1.confidence || 1.0, r2.confidence || 1.0) * 0.8,
              inferred: true
            });
          }
        }
      }
    }
  }
  
  return inferred;
}

/**
 * 获取统计信息
 */
function getStats() {
  const entities = query({ type: 'entity' });
  const relations = query({ type: 'relation' });
  
  return {
    entities: entities.length,
    relations: relations.length,
    categories: [...new Set(entities.map(e => e.category))],
    relation_types: [...new Set(relations.map(r => r.relation_type))]
  };
}

module.exports = {
  addEntity,
  addRelation,
  query,
  infer,
  getStats
};
