/**
 * Pointer Memory System - Redis Backend
 *
 * URI-based memory addressing with versioning and causal tracking.
 * Backed by Redis Hash for persistence and cross-node sharing.
 *
 * Format: ptr://{domain}/{topic}/{slug}@{version}
 *
 * Redis keys:
 *   ptr:data:{pointer}     → Hash with payload fields
 *   ptr:index:domain:{d}   → Set of pointers in domain
 *   ptr:index:topic:{t}    → Set of pointers with topic
 *   ptr:index:keywords:{k} → Set of pointers with keyword
 *   ptr:index:active        → Set of active (non-deprecated) pointers
 */

const crypto = require('crypto');

class RedisPointerSystem {
  /**
   * @param {import('ioredis').Redis | {host: string, port: number, password?: string}} redisOrConfig
   */
  constructor(redisOrConfig) {
    if (redisOrConfig && typeof redisOrConfig.get === 'function') {
      this.redis = redisOrConfig;
    } else {
      const Redis = require('ioredis');
      const config = redisOrConfig || {};
      this.redis = new Redis({
        host: config.host || process.env.REDIS_HOST || '10.10.0.1',
        port: config.port || parseInt(process.env.REDIS_PORT || '6379'),
        password: config.password || process.env.REDIS_PASSWORD || 'fsc-mesh-2026',
        lazyConnect: true,
        retryStrategy: (times) => Math.min(times * 200, 3000),
      });
    }
  }

  async connect() {
    if (this.redis.status === 'ready') return;
    await this.redis.connect();
  }

  async close() {
    await this.redis.quit();
  }

  // === Pointer Generation (pure, no IO) ===

  generatePointer(domain, topic, slug, version = 'v1') {
    return `ptr://${domain}/${topic}/${slug}@${version}`;
  }

  generateHashPointer(content) {
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return `ptr://hash/sha256:${hash.substring(0, 12)}`;
  }

  parsePointer(pointer) {
    const match = pointer.match(/^ptr:\/\/([^\/]+)\/([^\/]+)\/([^@]+)@(.+)$/);
    if (!match) throw new Error(`Invalid pointer format: ${pointer}`);
    return { domain: match[1], topic: match[2], slug: match[3], version: match[4] };
  }

  incrementVersion(version) {
    if (version.startsWith('v')) return `v${parseInt(version.substring(1)) + 1}`;
    return `${version}.1`;
  }

  compareVersions(v1, v2) {
    if (v1 === v2) return 0;
    if (v1.startsWith('v') && v2.startsWith('v')) {
      return parseInt(v1.substring(1)) - parseInt(v2.substring(1));
    }
    return v1.localeCompare(v2);
  }

  // === Storage Operations ===

  /**
   * Store a pointer payload in Redis
   */
  async store(pointer, payload) {
    const key = `ptr:data:${pointer}`;
    const data = {
      pointer,
      type: payload.type || 'fact',
      topic: payload.topic || '',
      content: payload.content || '',
      version: payload.version || 'v1',
      status: payload.status || 'active',
      keywords: JSON.stringify(payload.keywords || []),
      supersedes: payload.supersedes || '',
      metadata: JSON.stringify(payload.metadata || {}),
      created_at: payload.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const parsed = this.parsePointer(pointer);
    const pipeline = this.redis.pipeline();

    // Store payload
    pipeline.hset(key, data);

    // Update indices
    pipeline.sadd(`ptr:index:domain:${parsed.domain}`, pointer);
    pipeline.sadd(`ptr:index:topic:${parsed.topic}`, pointer);
    for (const kw of (payload.keywords || [])) {
      pipeline.sadd(`ptr:index:keywords:${kw.toLowerCase()}`, pointer);
    }
    if (data.status === 'active') {
      pipeline.sadd('ptr:index:active', pointer);
    }

    await pipeline.exec();
    return data;
  }

  /**
   * Get pointer payload
   */
  async get(pointer) {
    const raw = await this.redis.hgetall(`ptr:data:${pointer}`);
    if (!raw || !raw.pointer) return null;
    return {
      ...raw,
      keywords: JSON.parse(raw.keywords || '[]'),
      metadata: JSON.parse(raw.metadata || '{}'),
    };
  }

  /**
   * Create and store a payload
   */
  async createPayload({ pointer, type = 'fact', topic, content, version = 'v1', status = 'active', keywords = [], supersedes = null, metadata = {} }) {
    const payload = { pointer, type, topic, content, version, status, keywords, supersedes, metadata, created_at: new Date().toISOString() };
    await this.store(pointer, payload);
    return payload;
  }

  /**
   * Deprecate old pointer and create new version
   */
  async deprecateAndCreate(oldPointer, newPayload) {
    const oldData = await this.get(oldPointer);
    if (oldData) {
      await this.redis.hset(`ptr:data:${oldPointer}`, 'status', 'deprecated', 'updated_at', new Date().toISOString());
      await this.redis.srem('ptr:index:active', oldPointer);
    }

    const parsed = this.parsePointer(oldPointer);
    const newVersion = this.incrementVersion(parsed.version);
    const newPointer = this.generatePointer(parsed.domain, parsed.topic, parsed.slug, newVersion);

    const payload = await this.createPayload({
      ...newPayload,
      pointer: newPointer,
      version: newVersion,
      supersedes: oldPointer,
    });

    return payload;
  }

  /**
   * Get active pointer (latest non-deprecated version)
   */
  async getActivePointer(basePointer) {
    const parsed = this.parsePointer(basePointer);
    const prefix = `ptr://${parsed.domain}/${parsed.topic}/${parsed.slug}@`;

    const activePointers = await this.redis.smembers('ptr:index:active');
    let latestVersion = null;
    let latestPointer = null;

    for (const ptr of activePointers) {
      if (ptr.startsWith(prefix)) {
        const p = this.parsePointer(ptr);
        if (!latestVersion || this.compareVersions(p.version, latestVersion) > 0) {
          latestVersion = p.version;
          latestPointer = ptr;
        }
      }
    }
    return latestPointer;
  }

  /**
   * Search pointers by keywords
   */
  async searchByKeywords(keywords) {
    const pointerSets = keywords.map(kw => `ptr:index:keywords:${kw.toLowerCase()}`);
    const matchedPointers = await this.redis.sunion(...pointerSets);

    const results = [];
    for (const ptr of matchedPointers) {
      const payload = await this.get(ptr);
      if (payload && payload.status === 'active') {
        results.push(payload);
      }
    }
    return results;
  }

  /**
   * Search by domain
   */
  async searchByDomain(domain) {
    const pointers = await this.redis.smembers(`ptr:index:domain:${domain}`);
    const results = [];
    for (const ptr of pointers) {
      const payload = await this.get(ptr);
      if (payload) results.push(payload);
    }
    return results;
  }

  /**
   * Get all active pointers count
   */
  async count() {
    return await this.redis.scard('ptr:index:active');
  }

  /**
   * Export all pointers to JSON (for backup/migration)
   */
  async exportDirectory() {
    const allKeys = [];
    let cursor = '0';
    do {
      const [newCursor, keys] = await this.redis.scan(cursor, 'MATCH', 'ptr:data:*', 'COUNT', 100);
      cursor = newCursor;
      allKeys.push(...keys);
    } while (cursor !== '0');

    const directory = { version: '1.0', updated_at: new Date().toISOString(), pointers: {} };
    for (const key of allKeys) {
      const ptr = key.replace('ptr:data:', '');
      directory.pointers[ptr] = await this.get(ptr);
    }
    return directory;
  }

  /**
   * Import from JSON directory (migration from in-memory pointer.js)
   */
  async importDirectory(directory) {
    if (!directory.pointers) throw new Error('Invalid directory format');
    let count = 0;
    for (const [ptr, payload] of Object.entries(directory.pointers)) {
      await this.store(ptr, payload);
      count++;
    }
    return count;
  }
}

module.exports = { RedisPointerSystem };
