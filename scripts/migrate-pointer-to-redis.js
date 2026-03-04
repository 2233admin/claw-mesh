#!/usr/bin/env node
/**
 * 迁移工具: pointer.js (内存 Map) → pointer-redis.js (Redis Hash)
 *
 * 用法: node scripts/migrate-pointer-to-redis.js [pointers.json路径]
 */

const fs = require('fs');
const path = require('path');
const { RedisPointerSystem } = require('../memory/pointer-redis');

async function main() {
  const jsonPath = process.argv[2] || path.join(__dirname, '..', 'memory', 'pointers.json');

  if (!fs.existsSync(jsonPath)) {
    console.log(`No pointers.json found at ${jsonPath}, nothing to migrate.`);
    process.exit(0);
  }

  const directory = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const pointerCount = Object.keys(directory.pointers || {}).length;
  console.log(`Found ${pointerCount} pointers to migrate`);

  if (pointerCount === 0) {
    console.log('Nothing to migrate.');
    process.exit(0);
  }

  const ps = new RedisPointerSystem();
  await ps.connect();

  const imported = await ps.importDirectory(directory);
  console.log(`Migrated ${imported} pointers to Redis`);

  const count = await ps.count();
  console.log(`Redis active pointers: ${count}`);

  // Backup original file
  const backupPath = jsonPath + '.bak';
  fs.copyFileSync(jsonPath, backupPath);
  console.log(`Backup saved to ${backupPath}`);

  await ps.close();
  console.log('Migration complete.');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
