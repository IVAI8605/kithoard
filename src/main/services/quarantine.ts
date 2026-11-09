import fs from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import { CHANNELS } from '@shared/channels'
import { makeError } from '@shared/errors'
import type { DownloadState, QuarantineItem } from '@shared/types'
import { getDb } from '../db'
import { log } from '../log'
import { ensureDir, moveFile, pathExists } from '../safety/quarantine'

interface QuarantineRow {
  id: number
  download_id: string | null
  path: string
  reason: string
  created_at: number
  target_path: string | null
  title: string | null
  state: DownloadState | null
  asset_id: number | null
  total_bytes: number | null
}

export interface QuarantineService {
  list(): QuarantineItem[]
  restore(raw: unknown): Promise<{ ok: true }>
  discard(raw: unknown): Promise<{ ok: true }>
  /** 审批用的只读预览：把要恢复的条目连路径一起交给界面，不能只报数量 */
  plan(raw: unknown): { items: { id: number; path: string }[] }
}

/**
 * 隔离区只提供两个出口：恢复回原路径、放弃进系统回收站（§5.1）。
 * 恢复不覆盖任何已有文件；放弃也不物理删除，保证用户还有后悔余地。
 */
export function createQuarantineService(deps: {
  notify: (channel: string, payload: unknown) => void
}): QuarantineService {
  return {
    list() {
      const rows = getDb()
        .prepare(
          `SELECT q.id, q.download_id, q.path, q.reason, q.created_at,
                  d.target_path, d.state, d.asset_id, d.total_bytes,
                  a.title AS title
             FROM quarantine q
             LEFT JOIN downloads d ON d.id = q.download_id
             LEFT JOIN assets a ON a.id = d.asset_id
            ORDER BY q.created_at DESC`
        )
        .all() as QuarantineRow[]
      return rows.map((row) => ({
        id: row.id,
        downloadId: row.download_id,
        title: row.title,
        targetPath: row.target_path,
        path: row.path,
        reason: row.reason,
        createdAt: row.created_at
      }))
    },

    plan(raw) {
      const ids = new Set(readPlanIds(raw))
      // 用 list() 的同一份查询，保证审批看到的就是隔离区里真实存在的条目
      return {
        items: this.list()
          .filter((item) => ids.has(item.id))
          .map((item) => ({ id: item.id, path: item.path }))
      }
    },

    async restore(raw) {
      const row = loadRow(raw)
      if (row.download_id === null || row.target_path === null || row.state !== 'quarantined') {
        throw makeError('E_INVALID_ARG', 'id')
      }
      // 原位置已被占用时不覆盖，交回用户决定
      if (pathExists(row.target_path)) throw makeError('E_FILE_IN_USE', row.target_path)

      ensureDir(path.dirname(row.target_path))
      moveFile(row.path, row.target_path)
      const size = statSize(row.target_path) ?? 0
      const now = Date.now()
      const db = getDb()
      db.transaction(() => {
        db.prepare(
          `UPDATE downloads
              SET state = 'completed', received_bytes = ?, total_bytes = ?, error_code = NULL, updated_at = ?
            WHERE id = ?`
        ).run(size, row.total_bytes ?? size, now, row.download_id)
        const updated = db
          .prepare(
            `UPDATE local_files SET path = ?, status = 'present', size_bytes = ?, updated_at = ?
              WHERE path = ?`
          )
          .run(row.target_path, size, now, row.path)
        if (updated.changes === 0) {
          db.prepare(
            `INSERT INTO local_files (asset_id, download_id, path, status, size_bytes, created_at, updated_at)
             VALUES (?, ?, ?, 'present', ?, ?, ?)`
          ).run(row.asset_id, row.download_id, row.target_path, size, now, now)
        }
        db.prepare('DELETE FROM quarantine WHERE id = ?').run(row.id)
      })()
      emitState(deps.notify, row.download_id, 'completed', size, row.total_bytes ?? size, null)
      return { ok: true }
    },

    async discard(raw) {
      const row = loadRow(raw)
      if (row.download_id === null || row.state !== 'quarantined') {
        throw makeError('E_INVALID_ARG', 'id')
      }
      try {
        // §5.8：用户主动放弃时进系统回收站，不做物理删除
        await shell.trashItem(row.path)
      } catch (error) {
        log.error(`quarantine trash failed: ${row.id} ${describe(error)}`)
        throw makeError('E_UNKNOWN', 'trash failed')
      }

      const now = Date.now()
      const db = getDb()
      db.transaction(() => {
        db.prepare(`UPDATE downloads SET state = 'canceled', updated_at = ? WHERE id = ?`).run(
          now,
          row.download_id
        )
        db.prepare('DELETE FROM local_files WHERE path = ?').run(row.path)
        db.prepare('DELETE FROM quarantine WHERE id = ?').run(row.id)
      })()
      emitState(deps.notify, row.download_id, 'canceled', 0, row.total_bytes, null)
      return { ok: true }
    }
  }
}

/** 审批预览只接受 id 数组；空数组或非法值直接拒绝，不返回空清单糊弄过去 */
function readPlanIds(raw: unknown): number[] {
  const value = typeof raw === 'object' && raw !== null ? (raw as { ids?: unknown }).ids : undefined
  if (!Array.isArray(value) || value.length === 0) throw makeError('E_INVALID_ARG', 'ids')
  const ids = value.filter((item): item is number => Number.isInteger(item) && (item as number) > 0)
  if (ids.length !== value.length) throw makeError('E_INVALID_ARG', 'ids')
  return ids
}

function loadRow(raw: unknown): QuarantineRow {
  const value = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw makeError('E_INVALID_ARG', 'id')
  }
  const row = getDb()
    .prepare(
      `SELECT q.id, q.download_id, q.path, q.reason, q.created_at,
              d.target_path, d.state, d.asset_id, d.total_bytes
         FROM quarantine q
         LEFT JOIN downloads d ON d.id = q.download_id
        WHERE q.id = ?`
    )
    .get(value) as QuarantineRow | undefined
  if (!row) throw makeError('E_INVALID_ARG', 'id')
  return row
}

function emitState(
  notify: (channel: string, payload: unknown) => void,
  taskId: string,
  state: DownloadState,
  receivedBytes: number,
  totalBytes: number | null,
  errorCode: string | null
): void {
  notify(CHANNELS.downloadState, { taskId, state, receivedBytes, totalBytes, errorCode })
}

function statSize(filePath: string): number | null {
  try {
    const info = fs.statSync(filePath)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
