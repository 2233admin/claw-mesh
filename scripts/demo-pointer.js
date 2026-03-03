#!/usr/bin/env node

/**
 * Pointer System Demo
 * 
 * Creates test data and demonstrates all features
 */

const { PointerSystem } = require('../memory/pointer');
const { QdrantPointerStore } = require('../memory/qdrant-pointer');

// Mock embedding function (for demo without OpenAI)
function mockEmbedding(text) {
  // Generate deterministic "embedding" based on text
  const hash = text.split('').reduce((acc, char) => {
    return ((acc << 5) - acc) + char.charCodeAt(0);
  }, 0);
  
  // Create 1536-dim vector with some variation
  return Array(1536).fill(0).map((_, i) => {
    return Math.sin(hash + i) * 0.5 + 0.5;
  });
}

async function demo() {
  console.log('=== Pointer Memory OS Demo ===\n');

  const ps = new PointerSystem();

  // 1. Create test pointers
  console.log('1. Creating test pointers...\n');

  const testData = [
    {
      domain: 'finance',
      topic: 'rule',
      slug: 'revenue',
      content: 'Revenue recognition follows ASC 606 standard',
      keywords: ['revenue', 'accounting', 'ASC606']
    },
    {
      domain: 'api',
      topic: 'auth',
      slug: 'token',
      content: 'JWT tokens expire after 24 hours',
      keywords: ['jwt', 'token', 'auth', 'security']
    },
    {
      domain: 'code',
      topic: 'bug',
      slug: 'memory-leak',
      content: 'Memory leak caused by unclosed database connections',
      keywords: ['memory', 'leak', 'database', 'bug']
    },
    {
      domain: 'project',
      topic: 'config',
      slug: 'database',
      content: 'PostgreSQL connection pool size: 20',
      keywords: ['postgres', 'database', 'config', 'pool']
    }
  ];

  const pointers = [];
  for (const data of testData) {
    const ptr = ps.generatePointer(data.domain, data.topic, data.slug, 'v1');
    const payload = ps.createPayload({
      pointer: ptr,
      type: 'fact',
      topic: data.topic,
      content: data.content,
      keywords: data.keywords
    });
    ps.store(ptr, payload);
    pointers.push(ptr);
    console.log(`  ✓ Created: ${ptr}`);
  }

  console.log('\n2. Testing pointer_get...\n');
  const retrieved = ps.get(pointers[0]);
  console.log(`  pointer_get("${pointers[0]}"):`);
  console.log(`  → content: "${retrieved.content}"`);
  console.log(`  → keywords: [${retrieved.keywords.join(', ')}]`);
  console.log(`  → status: ${retrieved.status}`);

  console.log('\n3. Testing keyword search...\n');
  const searchResults = ps.searchByKeywords(['database', 'config']);
  console.log(`  search(['database', 'config']):`);
  searchResults.forEach(r => {
    console.log(`  → ${r.pointer}`);
    console.log(`    "${r.content}"`);
  });

  console.log('\n4. Testing version management...\n');
  const oldPtr = pointers[1]; // JWT token pointer
  console.log(`  Old: ${oldPtr}`);
  console.log(`  Content: "${ps.get(oldPtr).content}"`);
  
  const newPayload = ps.deprecateAndCreate(oldPtr, {
    type: 'fact',
    topic: 'auth',
    content: 'JWT tokens expire after 1 hour (security update)',
    keywords: ['jwt', 'token', 'auth', 'security', '2026']
  });
  
  console.log(`  New: ${newPayload.pointer}`);
  console.log(`  Content: "${newPayload.content}"`);
  console.log(`  Supersedes: ${newPayload.supersedes}`);
  console.log(`  Old status: ${ps.get(oldPtr).status}`);

  console.log('\n5. Testing pointer chain...\n');
  const chain = ps.getPointerChain(newPayload.pointer);
  console.log(`  Chain for ${newPayload.pointer}:`);
  chain.forEach((ptr, i) => {
    const p = ps.get(ptr);
    console.log(`  ${i + 1}. ${ptr} (${p.status})`);
  });

  console.log('\n6. Exporting directory...\n');
  const directory = ps.exportDirectory();
  console.log(`  Total pointers: ${Object.keys(directory.pointers).length}`);
  console.log(`  Active: ${Object.values(directory.pointers).filter(p => p.status === 'active').length}`);
  console.log(`  Deprecated: ${Object.values(directory.pointers).filter(p => p.status === 'deprecated').length}`);

  // Test with Qdrant if available
  console.log('\n7. Testing Qdrant integration (if available)...\n');
  
  try {
    const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
    const store = new QdrantPointerStore(qdrantUrl, 'demo_pointers');
    
    // Check if Qdrant is running
    const response = await fetch(`${qdrantUrl}/collections`);
    if (!response.ok) {
      throw new Error('Qdrant not available');
    }

    console.log('  ✓ Qdrant is running');
    
    // Initialize collection
    await store.initialize();
    console.log('  ✓ Collection initialized');

    // Store all pointers
    for (const ptr of pointers) {
      const payload = ps.get(ptr);
      const embedding = mockEmbedding(payload.content);
      await store.storePointer(payload, embedding);
    }
    console.log(`  ✓ Stored ${pointers.length} pointers`);

    // Test exact retrieval
    const exact = await store.getPointer(pointers[0]);
    console.log(`  ✓ Exact retrieval: ${exact.pointer}`);

    // Test vector search
    const queryEmbedding = mockEmbedding('database configuration');
    const results = await store.searchPointers(queryEmbedding, 3);
    console.log(`  ✓ Vector search results:`);
    results.forEach(r => {
      console.log(`    - ${r.pointer} (score: ${r.score.toFixed(3)})`);
    });

    // Test topic filter
    const authPointers = await store.getActiveByTopic('auth');
    console.log(`  ✓ Active 'auth' pointers: ${authPointers.length}`);

    console.log('\n  🎉 Qdrant integration working!');

  } catch (error) {
    console.log(`  ⚠ Qdrant not available: ${error.message}`);
    console.log('  To enable: docker run -d -p 6333:6333 qdrant/qdrant');
  }

  console.log('\n=== Demo Complete ===\n');

  // Summary
  console.log('Summary:');
  console.log(`  ✓ Pointer generation: ${pointers.length} pointers created`);
  console.log(`  ✓ Exact retrieval: Working`);
  console.log(`  ✓ Keyword search: Working`);
  console.log(`  ✓ Version management: Working`);
  console.log(`  ✓ Pointer chains: Working`);
  console.log(`  ✓ Directory export: Working`);
  console.log('\nNext steps:');
  console.log('  - Start Qdrant: docker run -d -p 6333:6333 qdrant/qdrant');
  console.log('  - Run Day 2: Implement causal correction + a2a chain');
  console.log('  - Run Day 3: MemoV fusion + evolver');
}

// Run demo
if (require.main === module) {
  demo().catch(error => {
    console.error('Demo failed:', error);
    process.exit(1);
  });
}

module.exports = { demo };
