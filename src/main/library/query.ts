import { makeError } from '@shared/errors'
import type { AssetType } from '@shared/types'

const TYPES: readonly AssetType[] = ['image', 'video', 'audio', 'font', 'template']
const MAX_KEYWORD = 100
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const MAX_PAGE = 100000

export interface LibraryQuery {
  /** null 表示全部类型；未关联素材的记录只在「全部」下出现 */
  type: AssetType | null
  keyword: string
  page: number
  pageSize: number
}

/**
 * 列表筛选的校验单独放纯函数里：
 * 1. 界面与未来 agent 网关共用同一套边界，不在 SQL 拼接处各写一遍；
 * 2. 分页参数非法时直接拒绝，避免把 NaN/OFFSET 传给 SQLite 后悄悄返回空列表。
 */
export function normalizeLibraryQuery(raw: unknown): LibraryQuery {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}

  const type = readType(record.type)
  const keyword = readKeyword(record.keyword)
  const page = readInt(record.page, 'page', 1, 1, MAX_PAGE)
  const pageSize = readInt(record.pageSize, 'pageSize', DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)

  return { type, keyword, page, pageSize }
}

/** LIKE 里的 % 和 _ 是通配符，用户搜「100%」时必须按字面量匹配 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function readType(value: unknown): AssetType | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !TYPES.includes(value as AssetType)) {
    throw makeError('E_INVALID_ARG', 'type')
  }
  return value as AssetType
}

function readKeyword(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw makeError('E_INVALID_ARG', 'keyword')
  const trimmed = value.trim()
  // 与 §6.3 的搜索关键词上限保持一致，超长关键词必然查不到东西
  if (trimmed.length > MAX_KEYWORD) throw makeError('E_INVALID_ARG', 'keyword')
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
