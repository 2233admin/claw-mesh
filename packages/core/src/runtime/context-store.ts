// RedisContextStore — persistent agent context for handoffs and recovery.
// Keys: fsc:context:{agentId} (HSET)
// Supports: save/load/handoff/compress

import type Redis from 'ioredis'
import { encode, decode } from '@msgpack/msgpack'

// ─── Types ───

export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp?: number
}

export interface ContextEntry {
  agentId: string
  messages: Message[]
  metadata: Record<string, unknown>
  updatedAt: number
  version: number
}

export interface HandoffResult {
  fromAgent: string
  toAgent: string
  messageCount: number
  compressed: boolean
  summary?: string
}

export interface ContextStoreOptions {
  redis: Redis
  maxMessages?: number        // default 100
  compressThreshold?: number  // default 50
  ttlSeconds?: number         // default 86400 (24h)
}

// ─── Constants ───

const KEY_PREFIX = 'fsc:context:'
const DEFAULTS = {
  maxMessages: 100,
  compressThreshold: 50,
  ttlSeconds: 86400,
} as const

function contextKey(agentId: string): string {
  return `${KEY_PREFIX}${agentId}`
}

// ─── Implementation ───

export class RedisContextStore {
  private readonly redis: Redis
  private readonly maxMessages: number
  private readonly compressThreshold: number
  private readonly ttlSeconds: number

  constructor(options: ContextStoreOptions) {
    this.redis = options.redis
    this.maxMessages = options.maxMessages ?? DEFAULTS.maxMessages
    this.compressThreshold = options.compressThreshold ?? DEFAULTS.compressThreshold
    this.ttlSeconds = options.ttlSeconds ?? DEFAULTS.ttlSeconds
  }

  async saveContext(agentId: string, messages: Message[], metadata?: Record<string, unknown>): Promise<void> {
    const key = contextKey(agentId)

    // optimistic concurrency: read current version
    const rawVersion = await this.redis.hget(key, 'version')
    const currentVersion = rawVersion ? parseInt(rawVersion, 10) : 0

    // trim to maxMessages (keep tail)
    const trimmed = messages.length > this.maxMessages
      ? messages.slice(-this.maxMessages)
      : messages

    const nextVersion = currentVersion + 1
    const packed = Buffer.from(encode(trimmed))

    const pipeline = this.redis.pipeline()
    pipeline.hset(key,
      'agentId', agentId,
      'messages', packed,
      'metadata', JSON.stringify(metadata ?? {}),
      'updatedAt', String(Date.now()),
      'version', String(nextVersion),
    )
    pipeline.expire(key, this.ttlSeconds)
    await pipeline.exec()
  }

  async loadContext(agentId: string): Promise<ContextEntry | null> {
    const raw = await this.redis.hgetallBuffer(contextKey(agentId))
    if (!raw || !raw.agentId) return null

    const messages = decode(raw.messages) as Message[]

    return {
      agentId: raw.agentId.toString(),
      messages,
      metadata: JSON.parse(raw.metadata.toString()),
      updatedAt: parseInt(raw.updatedAt.toString(), 10),
      version: parseInt(raw.version.toString(), 10),
    }
  }

  async handoff(fromAgent: string, toAgent: string, summary?: string): Promise<HandoffResult> {
    const source = await this.loadContext(fromAgent)
    if (!source) {
      throw new Error(`No context found for agent ${fromAgent}`)
    }

    let messages = source.messages
    let compressed = false

    // compress if over threshold
    if (messages.length > this.compressThreshold) {
      const keepCount = Math.ceil(messages.length * 0.6)
      const droppedCount = messages.length - keepCount

      const summaryText = summary ?? `[Compressed: ${droppedCount} earlier messages omitted]`
      const summaryMsg: Message = {
        role: 'system',
        content: summaryText,
        timestamp: Date.now(),
      }

      messages = [summaryMsg, ...messages.slice(-keepCount)]
      compressed = true
    }

    // identity re-injection
    const identityMsg: Message = {
      role: 'system',
      content: `<identity>You are ${toAgent}, continuing work from ${fromAgent}.</identity>`,
      timestamp: Date.now(),
    }

    const handoffMessages = [identityMsg, ...messages]

    await this.saveContext(toAgent, handoffMessages, {
      ...source.metadata,
      handoffFrom: fromAgent,
      handoffAt: Date.now(),
    })

    return {
      fromAgent,
      toAgent,
      messageCount: handoffMessages.length,
      compressed,
      summary: compressed ? summary : undefined,
    }
  }

  async deleteContext(agentId: string): Promise<void> {
    await this.redis.del(contextKey(agentId))
  }

  async listContexts(): Promise<string[]> {
    const result: string[] = []
    let cursor = '0'

    do {
      const [next, keys] = await this.redis.scan(
        cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', '100',
      )
      cursor = next
      for (const k of keys) {
        result.push(k.slice(KEY_PREFIX.length))
      }
    } while (cursor !== '0')

    return result
  }
}
