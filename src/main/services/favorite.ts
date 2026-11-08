import { makeError } from '@shared/errors'
import type { AssetType, FavoritePage } from '@shared/types'
import { getDb } from '../db'

/** §6.3：所有 id 数组长度 ≤ 200 */
const MAX_FAVORITE_IDS = 200
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const MAX_PAGE = 100000

interface FavoriteRow {
  id: number
  asset_id: number
  created_at: number
  title: string | null
  type: AssetType | null
  source_id: string | null
  remote_id: string | null
}

export interface FavoriteService {
  /** 单条切换：已收藏则取消，未收藏则收藏；返回操作后的收藏状态 */
  toggle(raw: unknown): Promise<{ ok: true; favorited: boolean }>
  /** 批量收藏；已收藏的素材不重复计入，返回实际新增条数 */
  add(raw: unknown): Promise<{ ok: true; added: number }>
  /** 批量取消收藏；不存在的素材忽略，返回实际移除条数 */
  remove(raw: unknown): Promise<{ ok: true; removed: number }>
  /** 分页列表，联表 assets 拿标题与类型；素材被清空后标题为 null */
  list(raw: unknown): FavoritePage
  /** 全部已收藏的素材 id，供卡片与详情页做状态联动 */
  ids(): number[]
}

export function createFavoriteService(): FavoriteService {
  return {
    async toggle(raw) {
      const assetId = readAssetId(raw)
      assertAssetsExist([assetId])
      const db = getDb()
      const existing = db
        .prepare('SELECT 1 AS value FROM favorites WHERE asset_id = ?')
        .get(assetId) as { value: number } | undefined
      if (existing) {
        db.prepare('DELETE FROM favorites WHERE asset_id = ?').run(assetId)
        return { ok: true, favorited: false }
      }
      db.prepare(
        'INSERT INTO favorites (asset_id, created_at) VALUES (?, ?)'
      ).run(assetId, Date.now())
      return { ok: true, favorited: true }
    },

    async add(raw) {
      const ids = readIds(raw)
      assertAssetsExist(ids)
      const db = getDb()
      const now = Date.now()
      const insert = db.prepare(
        'INSERT OR IGNORE INTO favorites (asset_id, created_at) VALUES (?, ?)'
      )
      let added = 0
      db.transaction(() => {
        for (const id of ids) {
          const info = insert.run(id, now)
          if (info.changes > 0) added += 1
        }
      })()
      return { ok: true, added }
    },

    async remove(raw) {
      const ids = readIds(raw)
      const db = getDb()
      const placeholders = ids.map(() => '?').join(',')
      const before = (
        db.prepare(`SELECT COUNT(*) AS value FROM favorites WHERE asset_id IN (${placeholders})`)
          .get(...ids) as { value: number }
      ).value
      db.prepare(`DELETE FROM favorites WHERE asset_id IN (${placeholders})`).run(...ids)
      return { ok: true, removed: before }
    },

    list(raw) {
      const query = normalizeFavoriteQuery(raw)
      const db = getDb()
      const clauses: string[] = []
      const params: unknown[] = []

      if (query.type) {
        clauses.push('a.type = ?')
        params.push(query.type)
      }
      if (query.keyword) {
        clauses.push('a.title LIKE ? ESCAPE \'\\\'')
        params.push(`%${escapeLike(query.keyword)}%`)
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''

      const total = (
        db
          .prepare(
            `SELECT COUNT(*) AS value
               FROM favorites f
               LEFT JOIN assets a ON a.id = f.asset_id
              ${where}`
          )
          .get(...params) as { value: number }
      ).value

      const rows = db
        .prepare(
          `SELECT f.id, f.asset_id, f.created_at,
                  a.title AS title, a.type AS type, a.source_id AS source_id, a.remote_id AS remote_id
             FROM favorites f
             LEFT JOIN assets a ON a.id = f.asset_id
            ${where}
            ORDER BY f.created_at DESC, f.id DESC
            LIMIT ? OFFSET ?`
        )
        .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as FavoriteRow[]

      return {
        items: rows.map((row) => ({
          id: row.id,
          assetId: row.asset_id,
          title: row.title,
          type: row.type,
          sourceId: row.source_id,
          remoteId: row.remote_id,
          createdAt: row.created_at
        })),
        total,
        page: query.page,
        pageSize: query.pageSize
      }
    },

    ids() {
      const rows = getDb()
        .prepare('SELECT asset_id FROM favorites ORDER BY created_at DESC')
        .all() as Array<{ asset_id: number }>
      return rows.map((row) => row.asset_id)
    }
  }
}

/**
 * 收藏前必须确认素材真的在库里：外键会拦住不存在的 id，
 * 但抛出来的是 SQLite 原始错误；这里提前转成 E_INVALID_ARG，界面才能给出可读提示。
 */
function assertAssetsExist(ids: number[]): void {
  const placeholders = ids.map(() => '?').join(',')
  const count = (
    getDb()
      .prepare(`SELECT COUNT(*) AS value FROM assets WHERE id IN (${placeholders})`)
      .get(...ids) as { value: number }
  ).value
  if (count !== ids.length) throw makeError('E_INVALID_ARG', 'assetId')
}

function readAssetId(raw: unknown): number {
  const value = typeof raw === 'object' && raw !== null ? (raw as { assetId?: unknown }).assetId : undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw makeError('E_INVALID_ARG', 'assetId')
  }
  return value
}

function readIds(raw: unknown): number[] {
  const value = typeof raw === 'object' && raw !== null ? (raw as { ids?: unknown }).ids : undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FAVORITE_IDS) {
    throw makeError('E_INVALID_ARG', 'ids')
  }
  const seen = new Set<number>()
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) {
      throw makeError('E_INVALID_ARG', 'ids')
    }
    seen.add(item)
  }
  return [...seen]
}

interface FavoriteQuery {
  type: AssetType | null
  keyword: string
  page: number
  pageSize: number
}

function normalizeFavoriteQuery(raw: unknown): FavoriteQuery {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const type = readType(record.type)
  const keyword = readKeyword(record.keyword)
  const page = readInt(record.page, 'page', 1, 1, MAX_PAGE)
  const pageSize = readInt(record.pageSize, 'pageSize', DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
  return { type, keyword, page, pageSize }
}

function readType(value: unknown): AssetType | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw makeError('E_INVALID_ARG', 'type')
  const valid: readonly AssetType[] = ['image', 'video', 'audio', 'font', 'template']
  if (!valid.includes(value as AssetType)) throw makeError('E_INVALID_ARG', 'type')
  return value as AssetType
}

function readKeyword(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw makeError('E_INVALID_ARG', 'keyword')
  const trimmed = value.trim()
  if (trimmed.length > 100) throw makeError('E_INVALID_ARG', 'keyword')
  return trimmed
}

function readInt(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw makeError('E_INVALID_ARG', field)
  }
  return value
}

/** LIKE 里的 % 和 _ 是通配符，用户搜「100%」时必须按字面量匹配 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}
