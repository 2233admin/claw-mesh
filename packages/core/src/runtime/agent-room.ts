/**
 * AgentRoom — P2P messaging for claw-mesh agents via Redis Streams.
 * Compatible with A2A AgentBus (shared Redis namespace).
 *
 * Message format (same as A2A Python side):
 * { type, from, to, content, request_id, timestamp, metadata }
 */

import type Redis from 'ioredis'
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MessageType =
  | 'message'
  | 'broadcast'
  | 'handoff'
  | 'consensus_request'
  | 'consensus_vote'

export interface RoomMessage {
  type: MessageType
  from: string
  to: string
  content: string
  request_id: string
  timestamp: number
  metadata?: Record<string, unknown>
}

export interface AgentRoomOptions {
  redis: Redis
  region?: string
}

// ---------------------------------------------------------------------------
// Keys — shared with A2A Python side
// ---------------------------------------------------------------------------

const KEYS = {
  agents: 'a2a:agents',
  inbox: (name: string) => `a2a:inbox:${name}`,
  region: (r: string) => `a2a:region:${r}`,
} as const

const CONSUMER_GROUP = 'room'
const MENTION_RE = /@([\w-]+)/g

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// ---------------------------------------------------------------------------
// AgentRoom
// ---------------------------------------------------------------------------

export class AgentRoom {
  private readonly redis: Redis
  private readonly region?: string

  constructor(opts: AgentRoomOptions) {
    this.redis = opts.redis
    this.region = opts.region
  }

  async join(agentName: string): Promise<void> {
    await this.redis.sadd(KEYS.agents, agentName)
    if (this.region) {
      await this.redis.sadd(KEYS.region(this.region), agentName)
    }
    // Create stream + consumer group; BUSYGROUP = already exists, ignore
    try {
      await this.redis.xgroup('CREATE', KEYS.inbox(agentName), CONSUMER_GROUP, '0', 'MKSTREAM')
    } catch (err: any) {
      if (!err.message?.includes('BUSYGROUP')) throw err
    }
  }

  async leave(agentName: string): Promise<void> {
    await this.redis.srem(KEYS.agents, agentName)
    if (this.region) {
      await this.redis.srem(KEYS.region(this.region), agentName)
    }
  }

  async send(
    from: string,
    to: string,
    content: string,
    type: MessageType = 'message',
    requestId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const fields: string[] = [
      'type', type,
      'from', from,
      'to', to,
      'content', content,
      'request_id', requestId ?? genId(),
      'timestamp', String(Date.now()),
    ]
    if (metadata) {
      fields.push('metadata', Buffer.from(msgpackEncode(metadata)).toString('base64'))
    }
    await this.redis.xadd(KEYS.inbox(to), '*', ...fields)
  }

  async broadcast(
    from: string,
    content: string,
    type: MessageType = 'broadcast',
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const targets = await this.members()
    const promises = targets
      .filter(t => t !== from)
      .map(t => this.send(from, t, content, type, undefined, metadata))
    await Promise.all(promises)
  }

  /** Parse @mentions and route; if none, broadcast. */
  async say(from: string, text: string): Promise<void> {
    const mentions = [...text.matchAll(MENTION_RE)].map(m => m[1])
    if (mentions.length === 0) {
      return this.broadcast(from, text)
    }
    await Promise.all(mentions.map(to => this.send(from, to, text)))
  }

  async readInbox(
    agentName: string,
    count = 10,
    blockMs = 0,
  ): Promise<RoomMessage[]> {
    const args: (string | number)[] = [
      'GROUP', CONSUMER_GROUP, agentName,
      'COUNT', count,
    ]
    if (blockMs > 0) args.push('BLOCK', blockMs)
    args.push('STREAMS', KEYS.inbox(agentName), '>')

    const raw = await (this.redis as any).xreadgroup(...args) as any[] | null
    if (!raw) return []

    const messages: RoomMessage[] = []
    // raw: [ [streamKey, [ [id, fields], ... ]] ]
    for (const [, entries] of raw) {
      for (const [id, fields] of entries) {
        const map: Record<string, string> = {}
        for (let i = 0; i < fields.length; i += 2) {
          map[fields[i]] = fields[i + 1]
        }
        const msg: RoomMessage = {
          type: (map.type ?? 'message') as MessageType,
          from: map.from ?? '',
          to: map.to ?? '',
          content: map.content ?? '',
          request_id: map.request_id ?? id,
          timestamp: Number(map.timestamp ?? 0),
        }
        if (map.metadata) {
          try {
            msg.metadata = msgpackDecode(Buffer.from(map.metadata, 'base64')) as Record<string, unknown>
          } catch { /* cross-language fallback: try JSON */
            try { msg.metadata = JSON.parse(map.metadata) } catch {}
          }
        }
        // ACK immediately
        await this.redis.xack(KEYS.inbox(agentName), CONSUMER_GROUP, id)
        messages.push(msg)
      }
    }
    return messages
  }

  async members(): Promise<string[]> {
    return this.redis.smembers(KEYS.agents)
  }

  async regionMembers(): Promise<string[]> {
    if (!this.region) return []
    return this.redis.smembers(KEYS.region(this.region))
  }
}
