import fs from 'node:fs'
import path from 'node:path'
import { clipboard, shell } from 'electron'
import { makeError } from '@shared/errors'
import type { AssetType, LocalFileItem, LocalFilePage, LocalFileStatus } from '@shared/types'
import { getDb } from '../db'
import { log } from '../log'
import { escapeLike, normalizeLibraryQuery } from '../library/query'

interface Row {
  id: number
  asset_id: number | null
  download_id: string | null
  path: string
  status: LocalFileStatus
  size_bytes: number | null
  created_at: number
  updated_at: number
  title: string | null
  type: AssetType | null
}

export interface LibraryService {
  /** 只读 local_files，并在返回前核对当前页的磁盘事实 */
  list(raw: unknown): LocalFilePage
  /** 用系统默认程序打开文件；应用内不内嵌播放器，避免引入解码与安全面 */
  open(raw: unknown): Promise<{ ok: true }>
  /** 在资源管理器中定位文件 */
  reveal(raw: unknown): { ok: true }
  copyPath(raw: unknown): { ok: true }
}

export function createLibraryService(): LibraryService {
  return {
    list(raw) {
      const query = normalizeLibraryQuery(raw)
      const db = getDb()
      const clauses = ["l.status IN ('present', 'missing')"]
      const params: unknown[] = []

      // 类型来自素材元数据；素材被清空（asset_id 为 NULL）的记录只在「全部」里出现
      if (query.type) {
        clauses.push('a.type = ?')
        params.push(query.type)
      }
      if (query.keyword) {
        clauses.push("(a.title LIKE ? ESCAPE '\\' OR l.path LIKE ? ESCAPE '\\')")
        const like = `%${escapeLike(query.keyword)}%`
        params.push(like, like)
      }
      const where = clauses.join(' AND ')

      const total = (
        db
          .prepare(
            `SELECT COUNT(*) AS value
               FROM local_files l
               LEFT JOIN assets a ON a.id = l.asset_id
              WHERE ${where}`
          )
          .get(...params) as { value: number }
      ).value

      const rows = db
        .prepare(
          `SELECT l.id, l.asset_id, l.download_id, l.path, l.status, l.size_bytes,
                  l.created_at, l.updated_at, a.title AS title, a.type AS type
             FROM local_files l
             LEFT JOIN assets a ON a.id = l.asset_id
            WHERE ${where}
            ORDER BY l.created_at DESC, l.id DESC
            LIMIT ? OFFSET ?`
        )
        .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as Row[]

      const items = rows.map((row) => reconcile(row))

      return { items, total, page: query.page, pageSize: query.pageSize }
    },

    async open(raw) {
      const row = readRow(raw)
      requirePresent(row)
      // openPath 返回空字符串表示成功，非空是系统给的原因（英文），只进 detail
      const failure = await shell.openPath(row.path)
      if (failure) {
        log.error(`library open failed: ${row.id} ${failure}`)
        throw makeError('E_UNKNOWN', failure)
      }
      return { ok: true }
    },

    reveal(raw) {
      const row = readRow(raw)
      requirePresent(row)
      shell.showItemInFolder(row.path)
      return { ok: true }
    },

    copyPath(raw) {
      const row = readRow(raw)
      if (row.status === 'quarantined') throw makeError('E_INVALID_ARG', 'id')
      // 文件被手工删掉时仍允许复制路径：用户可能要靠它去回收站或备份里找回
      clipboard.writeText(row.path)
      return { ok: true }
    }
  }
}

/** 打开/定位前必须确认文件真的在，避免给用户一个静默无反应的按钮 */
function requirePresent(row: Row): void {
  if (row.status === 'quarantined') throw makeError('E_INVALID_ARG', 'id')
  if (statFile(row.path) !== null) return
  markMissing(row.id)
  throw makeError('E_TEMP_MISSING', row.path)
}

/**
 * 磁盘才是事实来源：文件没了就标 missing，大小变了就更新大小；
 * 被外部还原回来的文件也从 missing 收回 present，避免用户重下同一份。
 * 只处理当前页，控制一次列表的 IO 量，启动时不做全量扫描。
 */
function reconcile(row: Row): LocalFileItem {
  const info = statFile(row.path)
  const now = Date.now()
  let status = row.status
  let sizeBytes = row.size_bytes

  if (status === 'present' && info === null) {
    markMissing(row.id)
    status = 'missing'
  } else if (status === 'missing' && info !== null) {
    status = 'present'
    sizeBytes = info.size
    getDb()
      .prepare(`UPDATE local_files SET status = 'present', size_bytes = ?, updated_at = ? WHERE id = ?`)
      .run(sizeBytes, now, row.id)
  } else if (status === 'present' && info !== null && sizeBytes !== info.size) {
    sizeBytes = info.size
    getDb()
      .prepare('UPDATE local_files SET size_bytes = ?, updated_at = ? WHERE id = ?')
      .run(sizeBytes, now, row.id)
  }

  return {
    id: row.id,
    assetId: row.asset_id,
    downloadId: row.download_id,
    title: row.title,
    type: row.type,
    fileName: path.win32.basename(row.path),
    path: row.path,
    status,
    sizeBytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function markMissing(id: number): void {
  getDb()
    .prepare(`UPDATE local_files SET status = 'missing', updated_at = ? WHERE id = ?`)
    .run(Date.now(), id)
}

function readRow(raw: unknown): Row {
  const value = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw makeError('E_INVALID_ARG', 'id')
  }
  const row = getDb()
    .prepare(
      `SELECT l.id, l.asset_id, l.download_id, l.path, l.status, l.size_bytes,
              l.created_at, l.updated_at, a.title AS title, a.type AS type
         FROM local_files l
         LEFT JOIN assets a ON a.id = l.asset_id
        WHERE l.id = ?`
    )
    .get(value) as Row | undefined
  if (!row) throw makeError('E_INVALID_ARG', 'id')
  return row
}

function statFile(filePath: string): { size: number } | null {
  try {
    const info = fs.statSync(filePath)
    return info.isFile() ? { size: info.size } : null
  } catch {
    return null
  }
}
