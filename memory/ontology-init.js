#!/usr/bin/env node
/**
 * Ontology Initialization
 * 初始化本体图
 */

const ontology = require('./ontology');
const fs = require('fs');
const path = require('path');

const ONTOLOGY_DIR = path.join(__dirname, '../.mem/ontology');
const GRAPH_FILE = path.join(ONTOLOGY_DIR, 'graph.jsonl');

console.log('🔧 Initializing Ontology...');

// 确保目录存在
if (!fs.existsSync(ONTOLOGY_DIR)) {
  fs.mkdirSync(ONTOLOGY_DIR, { recursive: true });
  console.log(`✅ Created directory: ${ONTOLOGY_DIR}`);
}

// 如果 graph.jsonl 已存在，备份
if (fs.existsSync(GRAPH_FILE)) {
  const backupFile = `${GRAPH_FILE}.backup.${Date.now()}`;
  fs.copyFileSync(GRAPH_FILE, backupFile);
  console.log(`📦 Backed up existing graph to: ${backupFile}`);
}

// 初始化空图
fs.writeFileSync(GRAPH_FILE, '');
console.log(`✅ Initialized empty graph: ${GRAPH_FILE}`);

// 添加初始实体和关系
console.log('📝 Adding initial entities...');

// 错误类型实体
const oomError = ontology.addEntity({
  name: 'OOM Error',
  category: 'error_type',
  attributes: {
    description: 'Out of Memory error',
    severity: 'high'
  }
});

const connectionError = ontology.addEntity({
  name: 'Connection Error',
  category: 'error_type',
  attributes: {
    description: 'Connection refused or timeout',
    severity: 'medium'
  }
});

// 修复方案实体
const memoryFix = ontology.addEntity({
  name: 'Increase Memory',
  category: 'fix_type',
  attributes: {
    command: '--memory=2g',
    effectiveness: 'high'
  }
});

const restartFix = ontology.addEntity({
  name: 'Restart Service',
  category: 'fix_type',
  attributes: {
    command: 'docker-compose restart',
    effectiveness: 'medium'
  }
});

// 建立关系
ontology.addRelation({
  from: oomError.id,
  to: memoryFix.id,
  relation_type: 'fixes',
  confidence: 0.93
});

ontology.addRelation({
  from: connectionError.id,
  to: restartFix.id,
  relation_type: 'fixes',
  confidence: 0.85
});

console.log('✅ Added initial entities and relations');

// 显示统计
const stats = ontology.getStats();
console.log('\n📊 Ontology Statistics:');
console.log(`  - Entities: ${stats.entities}`);
console.log(`  - Relations: ${stats.relations}`);
console.log(`  - Categories: ${stats.categories.join(', ')}`);
console.log(`  - Relation Types: ${stats.relation_types.join(', ')}`);

console.log('\n✅ Ontology initialization complete!');
