import crypto from 'node:crypto'
import type { AgentClientRecord, AgentScope } from '@shared/agent'
import { AGENT_SCOPES } from '@shared/agent'

/** 令牌与客户端一起存：一条记录就是一个可独立吊销的客户端 */
const TOKENS_KEY = 'agent.tokens'

/**
 * 存储做成注入而不是直接 import settings：
 * settings 依赖 Electron 的 safeStorage，测试环境没有 Electron，
 * 直接引用会让令牌逻辑无法单测，只能靠真机碰运气。
 */
export interface AgentAuthStore {
  read(key: string): string | null
  write(key: string, value: string): void
}

interface StoredToken extends AgentClientRecord {
  /** 只存 sha256，明文只在生成那一刻返回给界面，之后任何地方都取不到 */
  hash: string
}

export interface AgentAuth {
  /** 生成新令牌；返回明文一次，库里只留哈希 */
  issue(name: string, scopes: AgentScope[]): { token: string; client: AgentClientRecord }
  /** 校验并刷新 lastSeenAt；无效返回 null */
  verify(token: string): AgentClientRecord | null
  list(): AgentClientRecord[]
  /** 按客户端 id 吊销；返回是否真的删掉了 */
  revoke(clientId: string): boolean
  revokeAll(): void
  scopesOf(clientId: string): AgentScope[]
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function readAll(store: AgentAuthStore): StoredToken[] {
  const raw = store.read(TOKENS_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 逐条校验：库里的值可能被手工改坏，坏一条就丢一条，不能让整份列表失效
    return parsed.filter((item): item is StoredToken => {
      if (typeof item !== 'object' || item === null) return false
      const rec = item as Partial<StoredToken>
      return (
        typeof rec.id === 'string' &&
        typeof rec.name === 'string' &&
        typeof rec.hash === 'string' &&
        typeof rec.createdAt === 'number'
      )
    })
  } catch {
    return []
  }
}

function writeAll(store: AgentAuthStore, tokens: StoredToken[]): void {
  store.write(TOKENS_KEY, JSON.stringify(tokens))
}

function toClient(stored: StoredToken): AgentClientRecord {
  return {
    id: stored.id,
    name: stored.name,
    scopes: stored.scopes,
    createdAt: stored.createdAt,
    lastSeenAt: stored.lastSeenAt ?? null
  }
}

/** 只接受三个可授予作用域；destructive 永不写进令牌，必须逐次审批 */
function normalizeScopes(input: AgentScope[]): AgentScope[] {
  const wanted = new Set(input)
  return AGENT_SCOPES.filter((scope) => wanted.has(scope))
}

export function createAgentAuth(store: AgentAuthStore): AgentAuth {
  return {
    issue(name, scopes) {
      const token = crypto.randomBytes(32).toString('base64url')
      const hash = hashToken(token)
      const stored: StoredToken = {
        id: hash.slice(0, 8),
        name: name.trim().slice(0, 40) || '未命名客户端',
        hash,
        scopes: normalizeScopes(scopes),
        createdAt: Date.now(),
        lastSeenAt: null
      }
      writeAll(store, [...readAll(store), stored])
      return { token, client: toClient(stored) }
    },

    verify(token) {
      if (typeof token !== 'string' || token.length < 16) return null
      const hash = hashToken(token)
      const all = readAll(store)
      const hit = all.find((item) => item.hash === hash)
      if (!hit) return null
      const now = Date.now()
      // 每 30 秒才落一次 lastSeenAt，避免每个请求都写一次 settings
      if (!hit.lastSeenAt || now - hit.lastSeenAt > 30_000) {
        hit.lastSeenAt = now
        writeAll(store, all)
      }
      return toClient(hit)
    },

    list() {
      return readAll(store).map(toClient)
    },

    revoke(clientId) {
      const all = readAll(store)
      const left = all.filter((item) => item.id !== clientId)
      if (left.length === all.length) return false
      writeAll(store, left)
      return true
    },

    revokeAll() {
      writeAll(store, [])
    },

    scopesOf(clientId) {
      return readAll(store).find((item) => item.id === clientId)?.scopes ?? []
    }
  }
}
