import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CHANNELS } from '@shared/channels'
import { makeError } from '@shared/errors'
import type { AssetType, DownloadEstimate, DownloadState, DownloadTask } from '@shared/types'
import { getDb } from '../db'
import { isAutoStartEnabled, type DownloadEngine } from '../download/engine'
import { summarizeEstimate } from '../download/estimate'
import { buildTargetPath, extFromUrl, normalizePath, sanitizeBaseName } from '../download/naming'
import { nextState } from '../download/task'
import { checkDownloadUrl, needsLargeFileConfirm } from '../safety/policy'
import { getPlainSetting } from '../settings'

/** §6.3 规定所有 id 数组长度 ≤ 200 */
const MAX_TASKS_PER_ENQUEUE = 200
/** 任务 ID 是本应用生成的 UUID，超长输入直接判非法，不拿它去查库 */
const TASK_ID_MAX = 64
/** §5.3：失败重试超过 3 次需人工确认，避免坏链接无限重试 */
const MAX_AUTO_RETRY = 3
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
  total_bytes: number | null
  retry_count: number
  error_code: string | null
}

interface ListRow {
  id: string
  asset_id: number | null
  title: string | null
  state: DownloadState
  target_path: string
  total_bytes: number | null
  received_bytes: number
  error_code: string | null
  retry_count: number
  sort_order: number
  created_at: number
  updated_at: number
}

export interface DownloadService {
  /** 入参未校验即传入：校验与状态机都属于 service，界面与未来的 agent 网关共用同一份 */
  enqueue(raw: unknown): { taskIds: string[] }
  /** 批量下载确认框的体量预估；不落库、不发请求 */
  estimate(raw: unknown): DownloadEstimate
  pause(raw: unknown): Promise<{ ok: true }>
  cancel(raw: unknown): Promise<{ ok: true }>
  resume(raw: unknown): { ok: true }
  retry(raw: unknown): { ok: true }
  reorder(raw: unknown): { ok: true }
  /** 用户在启动恢复弹窗确认后，才让队列真正跑起来（§5.4：queued 不自动开始） */
  startQueue(): { ok: true }
  list(): DownloadTask[]
}

export function createDownloadService(deps: {
  engine: DownloadEngine
  notify: (channel: string, payload: unknown) => void
}): DownloadService {
  return {
    enqueue(raw) {
      const assetIds = readAssetIds(raw)
      const confirmLarge = asRecord(raw).confirmLarge === true
      const db = getDb()
      const assets = loadAssets(assetIds)
      // 授权不明或付费素材一律不下载；这条判断必须在入队时做，不能等下载完才发现
      for (const asset of assets) {
        if (asset.license === 'paid') throw makeError('E_LICENSE_PAID', String(asset.id))
        if (asset.license !== 'free') throw makeError('E_LICENSE_UNKNOWN', String(asset.id))
        if (!asset.preview_url) throw makeError('E_UNSUPPORTED', `asset ${asset.id} has no url`)
      }
      // 下载前安全拦截（§7.4-5）：扩展名黑/白名单先挡一层，真正的内容判定留给魔数校验
      for (const asset of assets) {
        const check = checkDownloadUrl(asset.preview_url as string, asset.type)
        if (!check.ok) throw makeError('E_UNSUPPORTED', check.reason)
        if (needsLargeFileConfirm(asset.size_bytes) && !confirmLarge) {
          // 界面批次会把它接到「确认下载这么大文件」弹窗；当前要求调用方显式确认
          throw makeError('E_INVALID_ARG', 'confirmLarge')
        }
      }

      const dir = resolveDownloadDir()
      const now = Date.now()
      const orderBase = readMaxSortOrder()
      const taskIds = insertTasks(db, assets, dir, now, orderBase)
      // §5.2：autoStart 只决定「新入队是否立即开始」，关了就先待在队列里
      if (isAutoStartEnabled()) deps.engine.pump()
      return { taskIds }
    },

    estimate(raw) {
      const assetIds = readAssetIds(raw)
      // 只查大小，不做许可与扩展名校验：预估阶段报错会让确认框直接弹不出来
      const assets = loadAssets(assetIds)
      return summarizeEstimate(assets.map((asset) => ({ sizeBytes: asset.size_bytes })))
    },

    async pause(raw) {
      const task = readTask(raw)
      // 严格按 §5.3：暂停只从 downloading 出发；排队中的任务请用取消
      nextState(task.state, 'pause')
      const handled = await deps.engine.stop(task.id, 'pause')
      if (handled) return { ok: true }

      // 没有在跑的会话（例如上次异常退出留下的 downloading）：直接按磁盘校正后置为暂停。
      // 等引擎收尾期间状态可能已变成 completed/failed，所以这里重新读一次，不用旧值覆盖
      const latest = readTask(raw)
      const state = nextState(latest.state, 'pause')
      const received = partSize(latest.target_path) ?? latest.received_bytes
      getDb()
        .prepare('UPDATE downloads SET state = ?, received_bytes = ?, updated_at = ? WHERE id = ?')
        .run(state, received, Date.now(), latest.id)
      emitState(latest.id, state, received, latest.total_bytes, null)
      return { ok: true }
    },

    async cancel(raw) {
      const task = readTask(raw)
      nextState(task.state, 'cancel')
      const handled = await deps.engine.stop(task.id, 'cancel')
      if (handled) return { ok: true }

      const latest = readTask(raw)
      const state = nextState(latest.state, 'cancel')
      getDb()
        .prepare('UPDATE downloads SET state = ?, updated_at = ? WHERE id = ?')
        .run(state, Date.now(), latest.id)
      // §5.8：`.part` 是应用临时文件，取消时允许物理删除
      removePart(latest.target_path)
      emitState(latest.id, state, latest.received_bytes, latest.total_bytes, latest.error_code)
      return { ok: true }
    },

    resume(raw) {
      const task = readTask(raw)
      const state = nextState(task.state, 'resume')
      // §5.3：继续的任务排到队首，用户点「继续」就是希望它优先跑
      const head = readMinSortOrder() - 1
      getDb()
        .prepare('UPDATE downloads SET state = ?, sort_order = ?, updated_at = ? WHERE id = ?')
        .run(state, head, Date.now(), task.id)
      emitState(task.id, state, task.received_bytes, task.total_bytes, task.error_code)
      deps.engine.pump()
      return { ok: true }
    },

    retry(raw) {
      const task = readTask(raw)
      const state = nextState(task.state, 'retry')
      // 超过 3 次仍失败说明重试本身解决不了问题，必须让界面明确问一次
      if (task.retry_count >= MAX_AUTO_RETRY && asRecord(raw).confirm !== true) {
        throw makeError('E_INVALID_ARG', 'retry confirmation required')
      }
      getDb()
        .prepare(
          'UPDATE downloads SET state = ?, retry_count = ?, error_code = NULL, updated_at = ? WHERE id = ?'
        )
        .run(state, task.retry_count + 1, Date.now(), task.id)
      emitState(task.id, state, task.received_bytes, task.total_bytes, null)
      deps.engine.pump()
      return { ok: true }
    },

    reorder(raw) {
      const orderedIds = readOrderedIds(raw)
      const db = getDb()
      const known = new Set(
        (db.prepare('SELECT id FROM downloads').all() as Array<{ id: string }>).map((row) => row.id)
      )
      if (!orderedIds.every((id) => known.has(id))) throw makeError('E_INVALID_ARG', 'orderedIds')

      const all = db
        .prepare('SELECT id FROM downloads ORDER BY sort_order, created_at')
        .all() as Array<{ id: string }>
      const ordered = new Set(orderedIds)
      const tail = all.map((row) => row.id).filter((id) => !ordered.has(id))
      const update = db.prepare('UPDATE downloads SET sort_order = ?, updated_at = ? WHERE id = ?')
      const now = Date.now()
      db.transaction(() => {
        orderedIds.forEach((id, index) => update.run(index + 1, now, id))
        // 未参与排序的任务按原相对顺序排到后面，避免出现两组同名次
        tail.forEach((id, index) => update.run(orderedIds.length + index + 1, now, id))
      })()
      return { ok: true }
    },

    startQueue() {
      deps.engine.pump()
      return { ok: true }
    },

    list() {
      const rows = getDb()
        .prepare(
          `SELECT d.id, d.asset_id, a.title AS title, d.state, d.target_path,
                  d.total_bytes, d.received_bytes, d.error_code, d.retry_count,
                  d.sort_order, d.created_at, d.updated_at
             FROM downloads d
             LEFT JOIN assets a ON a.id = d.asset_id
            ORDER BY d.sort_order, d.created_at`
        )
        .all() as ListRow[]
      return rows.map((row) => ({
        id: row.id,
        assetId: row.asset_id,
        title: row.title,
        state: row.state,
        targetPath: row.target_path,
        fileName: path.win32.basename(row.target_path),
        totalBytes: row.total_bytes,
        receivedBytes: row.received_bytes,
        errorCode: row.error_code,
        retryCount: row.retry_count,
        sortOrder: row.sort_order,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    }
  }

  function emitState(
    taskId: string,
    state: DownloadState,
    receivedBytes: number,
    totalBytes: number | null,
    errorCode: string | null
  ): void {
    deps.notify(CHANNELS.downloadState, { taskId, state, receivedBytes, totalBytes, errorCode })
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

function readOrderedIds(raw: unknown): string[] {
  const value = asRecord(raw).orderedIds
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TASKS_PER_ENQUEUE) {
    throw makeError('E_INVALID_ARG', 'orderedIds')
  }
  if (!value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= TASK_ID_MAX)) {
    throw makeError('E_INVALID_ARG', 'orderedIds')
  }
  // 重复 ID 无法定义先后，直接拒绝而不是猜一个顺序
  if (new Set(value).size !== value.length) throw makeError('E_INVALID_ARG', 'orderedIds')
  return value as string[]
}

function readTask(raw: unknown): TaskRow {
  const taskId = asRecord(raw).taskId
  if (typeof taskId !== 'string' || !taskId || taskId.length > TASK_ID_MAX) {
    throw makeError('E_INVALID_ARG', 'taskId')
  }
  const row = getDb()
    .prepare(
      `SELECT id, state, target_path, received_bytes, total_bytes, retry_count, error_code
         FROM downloads WHERE id = ?`
    )
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

function readMinSortOrder(): number {
  const row = getDb()
    .prepare('SELECT COALESCE(MIN(sort_order), 0) AS value FROM downloads')
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

/** §5.8：`.part` 属于应用临时文件，取消时允许物理删除 */
function removePart(targetPath: string): void {
  try {
    fs.unlinkSync(`${targetPath}.part`)
  } catch {
    // 不存在就是已经清理过
  }
}
