import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { makeError } from '@shared/errors'

/**
 * 统一 HTTP：超时、错误码映射、响应缓存。
 * 缓存至少 24 小时，满足 Pixabay 官方「搜索响应缓存 24h」要求；
 * 文件名用 URL 的 sha256，避免把带 API Key 的查询串写进磁盘文件名。
 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MEMORY_LIMIT = 50

interface CacheEntry<T> {
  savedAt: number
  data: T
}

export interface JsonResult<T> {
  data: T
  headers: Record<string, string>
}

const memory = new Map<string, CacheEntry<unknown>>()

function toDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hashUrl(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex')
}

function readCache<T>(url: string, cacheDir?: string): CacheEntry<T> | null {
  const now = Date.now()
  const inMemory = memory.get(url)
  if (inMemory && now - inMemory.savedAt < CACHE_TTL_MS) {
    return inMemory as CacheEntry<T>
  }
  if (!cacheDir) return null
  try {
    const file = path.join(cacheDir, `${hashUrl(url)}.json`)
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as CacheEntry<T>
    if (typeof parsed.savedAt !== 'number' || now - parsed.savedAt >= CACHE_TTL_MS) return null
    memory.set(url, parsed)
    return parsed
  } catch {
    return null
  }
}

function writeCache<T>(url: string, data: T, cacheDir?: string): void {
  const entry: CacheEntry<T> = { savedAt: Date.now(), data }
  memory.set(url, entry as CacheEntry<unknown>)
  if (memory.size > MEMORY_LIMIT) {
    const oldest = memory.keys().next().value
    if (oldest !== undefined) memory.delete(oldest)
  }
  if (!cacheDir) return
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(path.join(cacheDir, `${hashUrl(url)}.json`), JSON.stringify(entry), 'utf8')
  } catch {
    // 缓存写失败只影响下次是否重新请求，不影响本次结果
  }
}

function collectHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value
  })
  return result
}

function mapHttpError(status: number): ReturnType<typeof makeError> {
  if (status === 429) return makeError('E_RATE_LIMITED', `HTTP ${status}`)
  if (status === 400 || status === 401 || status === 403) {
    return makeError('E_AUTH_REQUIRED', `HTTP ${status}`)
  }
  if (status >= 500) return makeError('E_SOURCE_DOWN', `HTTP ${status}`)
  return makeError('E_NETWORK', `HTTP ${status}`)
}

export async function fetchJson<T>(
  url: string,
  options: {
    signal: AbortSignal
    cacheDir?: string
    timeoutMs?: number
    /** 认证头等；参与缓存 key 的哈希，避免不同 Key 命中同一份响应 */
    headers?: Record<string, string>
    /** 直链续期必须拿当下有效的结果，命中缓存会让签名链接被提前用掉 */
    skipCache?: boolean
  }
): Promise<JsonResult<T>> {
  const cacheKey = options.headers
    ? `${url}|${JSON.stringify(options.headers)}`
    : url
  const cached = options.skipCache ? null : readCache<T>(cacheKey, options.cacheDir)
  if (cached) {
    return { data: cached.data, headers: { 'x-cache': 'hit' } }
  }

  const timeout = AbortSignal.timeout(options.timeoutMs ?? 12_000)
  const signal = AbortSignal.any([options.signal, timeout])

  let response: Response
  try {
    response = await fetch(url, {
      signal,
      headers: { Accept: 'application/json', ...(options.headers ?? {}) }
    })
  } catch (error) {
    throw makeError('E_NETWORK', toDetail(error))
  }

  if (!response.ok) throw mapHttpError(response.status)

  let data: T
  try {
    data = (await response.json()) as T
  } catch (error) {
    throw makeError('E_SOURCE_DOWN', `invalid json: ${toDetail(error)}`)
  }

  if (!options.skipCache) writeCache(cacheKey, data, options.cacheDir)
  return { data, headers: collectHeaders(response.headers) }
}
