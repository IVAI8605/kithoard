import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CHANNELS } from '@shared/channels'
import { isAppError, makeError } from '@shared/errors'
import type { ImageProcessOptions, MediaTask, MediaTaskItem } from '@shared/types'
import { getDb } from '../db'
import { compressImageFile, transformImageFile, validateOptions } from '../media/image'
import { log } from '../log'

/** §6.3：id 数组长度 ≤ 200；单次批量处理沿用同一上限 */
const MAX_FILES = 200
/** 内存里只留最近 20 个任务，超出后最旧的先丢；处理任务本身不落库 */
const MAX_TASKS = 20

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.bmp'])

export interface MediaService {
  /** 启动一批图片处理；立即返回 taskId，进度通过事件推送 */
  start(raw: unknown): { taskId: string }
  /** 取消尚未开始与正在跑的下一条；已在处理的单条会做完 */
  cancel(raw: unknown): { ok: true }
  /** 当前会话内的任务快照，界面进入页面时先拉一次 */
  list(): MediaTask[]
}

interface FileRow {
  id: number
  asset_id: number | null
  path: string
  status: string
}

export function createMediaService(deps: {
  notify: (channel: string, payload: unknown) => void
}): MediaService {
  const tasks: MediaTask[] = []
  const controllers = new Map<string, AbortController>()

  return {
    start(raw) {
      const record = asRecord(raw)
      const ids = readIds(record.ids)
      // options 缺失时用空对象进入校验，统一得到 E_INVALID_ARG，而不是未捕获的 TypeError
      const options = validateOptions(asRecord(record.options) as unknown as ImageProcessOptions)
      const files = loadFiles(ids)

      const taskId = crypto.randomUUID()
      const task: MediaTask = {
        taskId,
        action: options.action,
        total: files.length,
        done: 0,
        failed: 0,
        items: files.map((file) => ({
          fileId: file.id,
          fileName: path.basename(file.path),
          state: 'queued'
        }))
      }
      tasks.unshift(task)
      if (tasks.length > MAX_TASKS) tasks.pop()

      const controller = new AbortController()
      controllers.set(taskId, controller)
      void runTask(task, files, options, controller.signal).finally(() => {
        controllers.delete(taskId)
      })
      return { taskId }
    },

    cancel(raw) {
      const taskId = asRecord(raw).taskId
      if (typeof taskId !== 'string' || !taskId) throw makeError('E_INVALID_ARG', 'taskId')
      const controller = controllers.get(taskId)
      if (!controller) throw makeError('E_INVALID_ARG', 'taskId')
      controller.abort()
      return { ok: true }
    },

    list() {
      // 返回快照，避免渲染层拿到主进程内部对象引用
      return tasks.map((task) => ({ ...task, items: task.items.map((item) => ({ ...item })) }))
    }
  }

  async function runTask(
    task: MediaTask,
    files: FileRow[],
    options: ImageProcessOptions,
    signal: AbortSignal
  ): Promise<void> {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      const item = task.items[index]

      if (signal.aborted) {
        item.state = 'failed'
        item.error = '已取消'
        task.done += 1
        task.failed += 1
        emit(task, item)
        continue
      }

      item.state = 'running'
      try {
        const result =
          options.action === 'compress'
            ? await compressImageFile(file.path, options.quality)
            : await transformImageFile(file.path, options)
        registerOutput(file, result.outputPath, result.bytes)
        item.state = 'completed'
        item.outputPath = result.outputPath
      } catch (error) {
        // 单条失败不中断整批（§7.6-5）；原因只留中文文案，英文异常进日志
        item.state = 'failed'
        item.error = isAppError(error) ? error.message : '处理失败'
        log.warn(
          `media failed file=${file.id} code=${isAppError(error) ? error.code : 'E_UNKNOWN'} detail=${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
      task.done += 1
      if (item.state === 'failed') task.failed += 1
      emit(task, item)
    }
    log.info(`media task=${task.taskId} action=${task.action} total=${task.total} failed=${task.failed}`)
  }

  function emit(task: MediaTask, item: MediaTaskItem): void {
    deps.notify(CHANNELS.mediaProgress, {
      taskId: task.taskId,
      done: task.done,
      total: task.total,
      failed: task.failed,
      item: { ...item }
    })
  }

  /**
   * 处理产物也要进本地素材库（V0.5 验收「处理产物入库」的前置能力）：
   * 新文件插一条记录；压缩覆盖原文件只更新原记录的大小与时间，不新增重复行。
   */
  function registerOutput(file: FileRow, outputPath: string, bytes: number): void {
    const db = getDb()
    const now = Date.now()
    if (path.resolve(outputPath) === path.resolve(file.path)) {
      db.prepare(
        'UPDATE local_files SET size_bytes = ?, status = ?, updated_at = ? WHERE id = ?'
      ).run(bytes, 'present', now, file.id)
      return
    }

    const existing = db.prepare('SELECT id FROM local_files WHERE path = ?').get(outputPath) as
      | { id: number }
      | undefined
    if (existing) {
      db.prepare(
        'UPDATE local_files SET status = ?, size_bytes = ?, updated_at = ? WHERE id = ?'
      ).run('present', bytes, now, existing.id)
      return
    }
    db.prepare(
      `INSERT INTO local_files (asset_id, download_id, path, status, size_bytes, created_at, updated_at)
       VALUES (?, NULL, ?, 'present', ?, ?, ?)`
    ).run(file.asset_id, outputPath, bytes, now, now)
  }
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
}

function readIds(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FILES) {
    throw makeError('E_INVALID_ARG', 'ids')
  }
  const seen = new Set<number>()
  for (const id of raw) {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      throw makeError('E_INVALID_ARG', 'ids')
    }
    seen.add(id)
  }
  return [...seen]
}

function loadFiles(ids: number[]): FileRow[] {
  const placeholders = ids.map(() => '?').join(', ')
  const rows = getDb()
    .prepare(
      `SELECT id, asset_id, path, status FROM local_files WHERE id IN (${placeholders})`
    )
    .all(...ids) as FileRow[]
  if (rows.length !== ids.length) throw makeError('E_INVALID_ARG', 'files')

  for (const row of rows) {
    if (row.status !== 'present') throw makeError('E_INVALID_ARG', 'file not present')
    if (!IMAGE_EXTS.has(path.extname(row.path).toLowerCase())) {
      throw makeError('E_MEDIA_UNSUPPORTED', path.basename(row.path))
    }
    if (!fs.existsSync(row.path)) throw makeError('E_INVALID_ARG', 'file missing')
  }
  return rows
}
