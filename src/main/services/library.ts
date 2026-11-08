import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, clipboard, dialog, shell } from 'electron'
import { makeError } from '@shared/errors'
import type {
  AssetType,
  LocalFileItem,
  LocalFilePage,
  LocalFileProps,
  LocalFileStatus
} from '@shared/types'
import { getDb } from '../db'
import { buildTargetPath, normalizePath } from '../download/naming'
import { assertMovableDir, assertPathLength, planRename, readIds } from '../library/fs-ops'
import { log } from '../log'
import { moveFile } from '../safety/quarantine'
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
  /** 属性面板：以磁盘为准，缺文件时明确报错而不是返回空白 */
  props(raw: unknown): LocalFileProps
  rename(raw: unknown): { ok: true; path: string }
  move(raw: unknown): { ok: true; failed: number[] }
  /** 删除走系统回收站，可还原；记录保留并标 missing，还原后下次列表自动恢复 */
  trash(raw: unknown): Promise<{ ok: true; failed: number[] }>
  /** 让用户选一个移动目标目录；取消返回 null */
  pickDir(): Promise<{ path: string | null }>
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
      requireFile(row)
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
      requireFile(row)
      shell.showItemInFolder(row.path)
      return { ok: true }
    },

    copyPath(raw) {
      const row = readRow(raw)
      if (row.status === 'quarantined') throw makeError('E_INVALID_ARG', 'id')
      // 文件被手工删掉时仍允许复制路径：用户可能要靠它去回收站或备份里找回
      clipboard.writeText(row.path)
      return { ok: true }
    },

    props(raw) {
      const row = readRow(raw)
      const info = requireFile(row)
      const ext = path.win32.extname(row.path).replace('.', '').toLowerCase()
      return {
        id: row.id,
        path: row.path,
        size: info.size,
        // 没有扩展名时用空串而不是 null：界面统一按「格式未知」展示
        ext,
        createdAt: info.birthtimeMs > 0 ? Math.round(info.birthtimeMs) : Math.round(info.ctimeMs),
        modifiedAt: Math.round(info.mtimeMs)
      }
    },

    rename(raw) {
      const row = readRow(raw)
      requireFile(row)
      const plan = planRename(row.path, readField(raw, 'newName'))
      // 只改大小写时 to 与 from 指向同一个文件，不能当成冲突
      const sameFile = normalizePath(plan.to).toLowerCase() === normalizePath(plan.from).toLowerCase()
      if (!sameFile && (fs.existsSync(plan.to) || pathTaken(plan.to, row.id))) {
        throw makeError('E_INVALID_ARG', 'newName')
      }
      try {
        fs.renameSync(plan.from, plan.to)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // 文件被播放器或编辑器占用时给出可行动的错误，而不是原始英文
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
          throw makeError('E_FILE_IN_USE', plan.from)
        }
        throw error
      }
      syncPath(row, plan.to)
      return { ok: true, path: plan.to }
    },

    move(raw) {
      const ids = readIds(raw)
      const targetDir = assertMovableDir(readField(raw, 'targetDir'))
      const failed: number[] = []

      for (const id of ids) {
        try {
          const row = readRowById(id)
          const info = requireFile(row)
          if (normalizePath(path.win32.dirname(row.path)).toLowerCase() === normalizePath(targetDir).toLowerCase()) {
            // 移到自己所在的目录只会生成「(1)」副本，语义是复制，不是移动
            throw makeError('E_INVALID_ARG', 'targetDir')
          }
          const base = path.win32.basename(row.path, path.win32.extname(row.path))
          const ext = path.win32.extname(row.path).replace('.', '')
          const target = buildTargetPath(
            targetDir,
            base,
            ext,
            (candidate) => fs.existsSync(candidate) || pathTaken(candidate, row.id)
          )
          assertPathLength(target)
          moveFile(row.path, target)
          syncPath(row, target, info.size)
        } catch (error) {
          failed.push(id)
          log.error(`library move failed: ${id} ${error instanceof Error ? error.message : ''}`)
        }
      }

      return { ok: true, failed }
    },

    async trash(raw) {
      const ids = readIds(raw)
      const failed: number[] = []

      for (const id of ids) {
        try {
          const row = readRowById(id)
          if (!fs.existsSync(row.path)) throw makeError('E_TEMP_MISSING', row.path)
          // 回收站是唯一删除入口：应用里没有「永久删除」，用户随时可以还原
          await shell.trashItem(row.path)
          markMissing(row.id)
        } catch (error) {
          failed.push(id)
          log.error(`library trash failed: ${id} ${error instanceof Error ? error.message : ''}`)
        }
      }

      return { ok: true, failed }
    },

    async pickDir() {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: '选择移动目标文件夹',
            properties: ['openDirectory', 'createDirectory']
          })
        : await dialog.showOpenDialog({
            title: '选择移动目标文件夹',
            properties: ['openDirectory', 'createDirectory']
          })
      return { path: result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0] }
    }
  }
}

/** 打开/定位/改名/移动前必须确认文件真的在，避免给用户一个静默无反应的按钮 */
function requireFile(row: Row): fs.Stats {
  if (row.status === 'quarantined') throw makeError('E_INVALID_ARG', 'id')
  const info = statFile(row.path)
  if (info !== null) return info
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

/**
 * 文件已经在磁盘上换位置后，库里的路径必须跟着走；
 * 下载任务也同步 target_path，否则重试会按旧路径再下一份。
 */
function syncPath(row: Row, nextPath: string, sizeBytes?: number): void {
  const db = getDb()
  const now = Date.now()
  db.transaction(() => {
    db.prepare(
      `UPDATE local_files
          SET path = ?, status = 'present', size_bytes = COALESCE(?, size_bytes), updated_at = ?
        WHERE id = ?`
    ).run(nextPath, sizeBytes ?? null, now, row.id)
    if (row.download_id) {
      try {
        db.prepare('UPDATE downloads SET target_path = ?, updated_at = ? WHERE id = ?').run(
          nextPath,
          now,
          row.download_id
        )
      } catch (error) {
        // 目标路径被另一条历史任务占用时不能让整笔事务回滚：文件已经移动成功，
        // 最坏情况只是那次重试会按新路径另起一份，比丢记录好
        log.error(
          `library sync download failed: ${row.download_id} ${error instanceof Error ? error.message : ''}`
        )
      }
    }
  })()
}

/** 库里已有同路径记录时不能再写入，否则 UNIQUE 冲突会把整个事务打回 */
function pathTaken(fullPath: string, excludeId: number): boolean {
  const hit = getDb()
    .prepare('SELECT 1 AS value FROM local_files WHERE path = ? AND id <> ?')
    .get(fullPath, excludeId)
  return hit !== undefined
}

function readField(raw: unknown, key: string): unknown {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[key] : undefined
}

function readRow(raw: unknown): Row {
  const value = readField(raw, 'id')
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw makeError('E_INVALID_ARG', 'id')
  }
  return readRowById(value)
}

function readRowById(id: number): Row {
  const row = getDb()
    .prepare(
      `SELECT l.id, l.asset_id, l.download_id, l.path, l.status, l.size_bytes,
              l.created_at, l.updated_at, a.title AS title, a.type AS type
         FROM local_files l
         LEFT JOIN assets a ON a.id = l.asset_id
        WHERE l.id = ?`
    )
    .get(id) as Row | undefined
  if (!row) throw makeError('E_INVALID_ARG', 'id')
  return row
}

function statFile(filePath: string): fs.Stats | null {
  try {
    const info = fs.statSync(filePath)
    return info.isFile() ? info : null
  } catch {
    return null
  }
}
