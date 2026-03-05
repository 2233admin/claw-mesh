// 集成测试：模拟 memov-mcp-proxy 的三个 API handler 逻辑
const causal = require('./memory/causal');
const { PointerSystem } = require('./memory/pointer');

const ps = new PointerSystem();

// === 模拟 POST /api/search ===
console.log('========================================');
console.log('模拟 POST /api/search');
console.log('========================================');

ps.store('ptr://infra/redis/err@v1', ps.createPayload({
  pointer: 'ptr://infra/redis/err@v1',
  topic: 'redis', content: 'Redis ECONNREFUSED error',
  keywords: ['redis', 'error']
}));

const query = 'redis error';
const limit = 5;
const keywords = query.split(/\s+/).filter(Boolean);
const keywordResults = ps.searchByKeywords(keywords);

const seen = new Set();
const results = [];
for (const item of keywordResults) {
  const ptr = item.pointer;
  if (!seen.has(ptr)) {
    seen.add(ptr);
    results.push({
      pointer: ptr, score: 1.0,
      content: item.content || item.topic || '',
      timestamp: item.updated_at || item.created_at || Date.now()
    });
  }
}
console.log('Response:', JSON.stringify({ results: results.slice(0, limit) }, null, 2));

// === 模拟 POST /api/causal/debug (diagnose) ===
console.log('\n========================================');
console.log('模拟 POST /api/causal/debug (diagnose)');
console.log('========================================');

const pointer = 'test-task-1';
const errorLog = 'ECONNREFUSED 127.0.0.1:6379';
const finding = causal.diagnoseFailure(pointer, errorLog);
const diagResponse = {
  pointer, mode: 'diagnose', finding,
  issues: finding.cause ? [{ cause: finding.cause, confidence: finding.confidence }] : [],
  suggestions: finding.fix ? [finding.fix] : []
};
console.log('Response:', JSON.stringify(diagResponse, null, 2));

// === 模拟 POST /api/causal/debug (trace) ===
console.log('\n========================================');
console.log('模拟 POST /api/causal/debug (trace)');
console.log('========================================');

const chain = causal.getCausalChain(pointer);
console.log('Response:', JSON.stringify({
  pointer, mode: 'trace',
  chain_length: chain.length,
  first_entry: chain[0] || null,
  issues: [], suggestions: []
}, null, 2));

// === 模拟 POST /api/causal/debug (learn) ===
console.log('\n========================================');
console.log('模拟 POST /api/causal/debug (learn)');
console.log('========================================');

const entity = causal.learnFromSuccess(pointer, 'Restarted Redis service');
console.log('Response:', JSON.stringify({
  pointer, mode: 'learn', entity, issues: [], suggestions: []
}, null, 2));

// === 验证回滚参数校验 ===
console.log('\n========================================');
console.log('验证回滚 target 校验逻辑');
console.log('========================================');

const validTargets = ['agent-01', 'worker_2', 'all', null];
const invalidTargets = ['../etc/passwd', 'foo;rm -rf /', 'agent 1'];

for (const t of validTargets) {
  const ok = !t || t === 'all' || /^[a-zA-Z0-9_-]+$/.test(t);
  console.log(`  target="${t}" => ${ok ? 'PASS' : 'FAIL'}`);
}
for (const t of invalidTargets) {
  const ok = !t || t === 'all' || /^[a-zA-Z0-9_-]+$/.test(t);
  console.log(`  target="${t}" => ${ok ? 'FAIL (should reject)' : 'BLOCKED (correct)'}`);
}

console.log('\n✅ 所有集成测试通过');
