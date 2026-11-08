import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AssetType, DownloadState } from '@shared/types'
import { makeError } from '@shared/errors'
import { getDb } from '../db'
import { buildTargetPath, extFromUrl, normalizePath, sanitizeBaseName } from '../download/naming'
import { nextState } from '../download/task'
import { getPlainSetting } from '../settings'

/** §6.3 规定所有 id 数组长度 ≤ 200 */
const MAX_TASKS_PER_ENQUEUE = 200
/** 任务 ID 是本应用生成的 UUID，超长输入直接判非法，不拿它去查库 */
const TASK_ID_MAX = 64
const UNIQUE_RETRY = 3

interface AssetRow {
  id: number
  title: string
  type: AssetType
  preview_url: string | null
  license: 'free' | 'paid' | 'unknown'
  size_bytes: number | null
}

interface TaskRow {
  id: string
  state: DownloadState
  target_path: string
  received_bytes: number
}

export interface DownloadService {
  /** 入参未校验即传入：校验与状态机都属于 service，界面与未来的 agent 网关共用同一份 */
  enqueue(raw: unknown): { taskIds: string[] }
  pause(raw: unknown): { ok: true }
  cancel(raw: unknown): { ok: true }
}

export function createDownloadService(): DownloadService {
  return {
    enqueue(raw) {
      const assetIds = readAssetIds(raw)
      const db = getDb()
      const assets = loadAssets(assetIds)
      // 授权不明或付费素材一律不下载；这条判断必须在入队时做，不能等下载完才发现
      for (const asset of assets) {
        if (asset.license === 'paid') throw makeError('E_LICENSE_PAID', String(asset.id))
        if (asset.license !== 'free') throw makeError('E_LICENSE_UNKNOWN', String(asset.id))
        if (!asset.preview_url) throw makeError('E_UNSUPPORTED', `asset ${asset.id} has no url`)
      }

      const dir = resolveDownloadDir()
      const now = Date.now()
      const orderBase = readMaxSortOrder()
      return { taskIds: insertTasks(db, assets, dir, now, orderBase) }
    },

    pause(raw) {
      const task = readTask(raw)
      // 严格按 §5.3：暂停只从 downloading 出发；排队中的任务请用取消
      const state = nextState(task.state, 'pause')
      // 进度以磁盘为准：中止过请求后，DB 里的 received_bytes 可能落后于 .part 实际大小
      const received = partSize(task.target_path) ?? task.received_bytes
      getDb()
        .prepare('UPDATE downloads SET state = ?, received_bytes = ?, updated_at = ? WHERE id = ?')
        .run(state, received, Date.now(), task.id)
      return { ok: true }
    },

    cancel(raw) {
      const task = readTask(raw)
      const state = nextState(task.state, 'cancel')
      getDb()
        .prepare('UPDATE downloads SET state = ?, updated_at = ? WHERE id = ?')
        .run(state, Date.now(), task.id)
      // .part 的物理删除放在下载引擎批次：本批还不会产生临时文件，
      // 提前写删除逻辑既没有可删对象，也会掩盖引擎落盘是否真的发生
      return { ok: true }
    }
  }
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
}

function readAssetIds(raw: unknown): number[] {
  const value = asRecord(raw).assetIds
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TASKS_PER_ENQUEUE) {
    throw makeError('E_INVALID_ARG', 'assetIds')
  }
  if (!value.every((id) => typeof id === 'number' && Number.isInteger(id) && id > 0)) {
    throw makeError('E_INVALID_ARG', 'assetIds')
  }
  // 同一批里重复的素材只入队一次，否则用户点两下会得到两条同名任务
  return Array.from(new Set(value as number[]))
}

function readTask(raw: unknown): TaskRow {
  const taskId = asRecord(raw).taskId
  if (typeof taskId !== 'string' || !taskId || taskId.length > TASK_ID_MAX) {
    throw makeError('E_INVALID_ARG', 'taskId')
  }
  const row = getDb()
    .prepare('SELECT id, state, target_path, received_bytes FROM downloads WHERE id = ?')
    .get(taskId) as TaskRow | undefined
  if (!row) throw makeError('E_INVALID_ARG', 'taskId')
  return row
}

function loadAssets(assetIds: number[]): AssetRow[] {
  const placeholders = assetIds.map(() => '?').join(', ')
  const rows = getDb()
    .prepare(
      `SELECT id, title, type, preview_url, license, size_bytes
         FROM assets
        WHERE id IN (${placeholders})`
    )
    .all(...assetIds) as AssetRow[]
  // 有一条查不到就整批拒绝：部分成功会让界面出现「点了 5 个只下了 3 个」且说不清原因
  if (rows.length !== assetIds.length) throw makeError('E_INVALID_ARG', 'assetIds')
  return rows
}

/**
 * 默认目录与配置默认值一致（§5.2 的 download.dir）；
 * 目录不可写必须在入队时就报错，不能等下载到一半才发现（§7.4-验收 12）。
 */
function resolveDownloadDir(): string {
  const configured = getPlainSetting('download.dir')?.trim()
  const dir = configured || path.join(os.homedir(), 'Pictures', 'Kithoard')
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.accessSync(dir, fs.constants.W_OK)
  } catch {
    throw makeError('E_DIR_UNWRITABLE', dir)
  }
  return dir
}

function readMaxSortOrder(): number {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS value FROM downloads')
    .get() as { value: number }
  return row.value
}

/**
 * 「分配唯一文件名 → 插库」放在一个事务里（§5.6）。
 * 目标路径的唯一性最终由 UNIQUE 约束裁决；这里最多重试 3 次，是为了在极端竞态下重算文件名，
 * 而不是无限循环——重复失败说明有别的逻辑在持续占位，继续重试只会掩盖问题。
 */
function insertTasks(
  db: ReturnType<typeof getDb>,
  assets: AssetRow[],
  dir: string,
  now: number,
  orderBase: number
): string[] {
  const insert = db.prepare(
    `INSERT INTO downloads (
       id, asset_id, state, target_path, url, total_bytes, sort_order, created_at, updated_at
     ) VALUES (
       @id, @assetId, 'queued', @targetPath, @url, @totalBytes, @sortOrder, @now, @now
     )`
  )
  const taken = db.prepare('SELECT 1 FROM downloads WHERE target_path = ?')

  const write = db.transaction((rows: AssetRow[]): string[] =>
    rows.map((asset, index) => {
      const url = asset.preview_url as string
      const base = sanitizeBaseName(asset.title)
      const ext = extFromUrl(url) ?? (asset.type === 'video' ? 'mp4' : 'jpg')
      const targetPath = buildTargetPath(dir, base, ext, (fullPath) => {
        // 磁盘已有同名文件、或队列里已经占了同名路径，都算冲突
        return fs.existsSync(fullPath) || taken.get(fullPath) !== undefined
      })
      const id = crypto.randomUUID()
      insert.run({
        id,
        assetId: asset.id,
        targetPath: normalizePath(targetPath),
        url,
        totalBytes: asset.size_bytes,
        sortOrder: orderBase + index + 1,
        now
      })
      return id
    })
  )

  let lastError: unknown = null
  for (let attempt = 0; attempt < UNIQUE_RETRY; attempt += 1) {
    try {
      return write(assets)
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      lastError = error
    }
  }
  throw makeError('E_UNKNOWN', lastError instanceof Error ? lastError.message : undefined)
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as { code?: unknown; message?: unknown }
  return (
    record.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    (typeof record.message === 'string' && record.message.includes('UNIQUE constraint failed'))
  )
}

/** 读取 `.part` 实际大小；不存在时返回 null，让调用方决定沿用旧值还是按丢失处理 */
function partSize(targetPath: string): number | null {
  try {
    const info = fs.statSync(`${targetPath}.part`)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}
