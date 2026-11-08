import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CHANNELS } from '@shared/channels'
import { isAppError, makeError } from '@shared/errors'
import type {
  AudioConvertOptions,
  AudioExtractOptions,
  ImageProcessOptions,
  MediaProcessOptions,
  MediaTask,
  MediaTaskItem,
  VideoConvertOptions,
  VideoScreenshotOptions
} from '@shared/types'
import { getDb } from '../db'
import { compressImageFile, transformImageFile, validateOptions } from '../media/image'
import {
  buildAudioCompressCommand,
  buildAudioConvertCommand,
  buildAudioExtractCommand,
  buildVideoCompressCommand,
  buildVideoConvertCommand,
  buildVideoScreenshotCommand,
  ffmpegPath,
  isFfmpegAvailable,
  runFfmpeg
} from '../media/ffmpeg'
import { log } from '../log'

/** §6.3：id 数组长度 ≤ 200；单次批量处理沿用同一上限 */
const MAX_FILES = 200
/** 内存里只留最近 20 个任务，超出后最旧的先丢；处理任务本身不落库 */
const MAX_TASKS = 20

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.bmp'])
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.webm', '.mov'])
const AUDIO_EXTS = new Set(['.mp3', '.aac', '.wav', '.flac'])

export interface MediaService {
  /** 启动一批媒体处理；立即返回 taskId，进度通过事件推送 */
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
      const options = validateMediaOptions(record.options as MediaProcessOptions)
      // 音视频动作先做二进制自检，缺 FFmpeg 时给专门错误码（§7.7-1）
      if ((isVideoAction(options.action) || isAudioAction(options.action)) && !isFfmpegAvailable()) {
        throw makeError('E_FFMPEG_MISSING', ffmpegPath())
      }
      const files = loadFiles(ids, options.action)

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
      return tasks.map((task) => ({ ...task, items: task.items.map((item) => ({ ...item })) }))
    }
  }

  async function runTask(
    task: MediaTask,
    files: FileRow[],
    options: MediaProcessOptions,
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
        const result = await processOne(file, options, signal)
        registerOutput(file, result.outputPath, result.bytes)
        item.state = 'completed'
        item.outputPath = result.outputPath
      } catch (error) {
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
   * 处理产物也要进本地素材库（§7.6-7 / §7.7 验收「处理产物入库」的前置能力）：
   * 新文件插一条记录；压缩覆盖原文件只更新原记录的大小与时间，不产生重复行。
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

function loadFiles(ids: number[], action: MediaProcessOptions['action']): FileRow[] {
  const placeholders = ids.map(() => '?').join(', ')
  const rows = getDb()
    .prepare(
      `SELECT id, asset_id, path, status FROM local_files WHERE id IN (${placeholders})`
    )
    .all(...ids) as FileRow[]
  if (rows.length !== ids.length) throw makeError('E_INVALID_ARG', 'files')

  for (const row of rows) {
    if (row.status !== 'present') throw makeError('E_INVALID_ARG', 'file not present')
    if (!fs.existsSync(row.path)) throw makeError('E_INVALID_ARG', 'file missing')
    const ext = path.extname(row.path).toLowerCase()
    if (isVideoAction(action) && !VIDEO_EXTS.has(ext)) {
      throw makeError('E_MEDIA_UNSUPPORTED', path.basename(row.path))
    }
    if (isAudioAction(action) && !AUDIO_EXTS.has(ext)) {
      throw makeError('E_MEDIA_UNSUPPORTED', path.basename(row.path))
    }
    if (isImageAction(action) && !IMAGE_EXTS.has(ext)) {
      throw makeError('E_MEDIA_UNSUPPORTED', path.basename(row.path))
    }
  }
  return rows
}

function isVideoAction(action: MediaProcessOptions['action']): boolean {
  return ['videoConvert', 'videoCompress', 'videoScreenshot'].includes(action)
}

function isAudioAction(action: MediaProcessOptions['action']): boolean {
  return ['audioConvert', 'audioCompress', 'audioExtract'].includes(action)
}

function isImageAction(action: MediaProcessOptions['action']): boolean {
  return ['convert', 'compress', 'edit'].includes(action)
}

/** 校验媒体处理入参；参数错误统一 E_INVALID_ARG，不让 ffmpeg/sharp 的英文异常冒到界面 */
export function validateMediaOptions(raw: MediaProcessOptions): MediaProcessOptions {
  if (!raw || typeof raw !== 'object') throw makeError('E_INVALID_ARG', 'options')
  const action = raw.action
  if (!['convert', 'compress', 'edit', 'videoConvert', 'videoCompress', 'videoScreenshot', 'audioConvert', 'audioCompress', 'audioExtract'].includes(action)) {
    throw makeError('E_INVALID_ARG', 'action')
  }

  if (action === 'convert' || action === 'compress' || action === 'edit') {
    return validateOptions(raw as ImageProcessOptions)
  }

  if (action === 'videoConvert') {
    const options = raw as VideoConvertOptions
    if (options.crf !== undefined && (!Number.isInteger(options.crf) || options.crf < 0 || options.crf > 51)) {
      throw makeError('E_INVALID_ARG', 'crf')
    }
    if (options.width !== undefined && (!Number.isInteger(options.width) || options.width < 1 || options.width > 20000)) {
      throw makeError('E_INVALID_ARG', 'width')
    }
    if (options.height !== undefined && (!Number.isInteger(options.height) || options.height < 1 || options.height > 20000)) {
      throw makeError('E_INVALID_ARG', 'height')
    }
    if (options.bitrate !== undefined && !/^\d+k$/i.test(options.bitrate)) {
      throw makeError('E_INVALID_ARG', 'bitrate')
    }
    return options
  }

  if (action === 'videoCompress' || action === 'audioCompress') {
    return raw
  }

  if (action === 'videoScreenshot') {
    const options = raw as VideoScreenshotOptions
    if (!options.at || !/^\d{2}:\d{2}:\d{2}(\.\d{1,2})?$/.test(options.at)) {
      throw makeError('E_INVALID_ARG', 'at')
    }
    return options
  }

  if (action === 'audioConvert') {
    const options = raw as AudioConvertOptions
    if (options.format !== undefined && !['mp3', 'aac', 'wav', 'flac'].includes(options.format)) {
      throw makeError('E_INVALID_ARG', 'format')
    }
    if (options.bitrate !== undefined && !/^\d+k$/i.test(options.bitrate)) {
      throw makeError('E_INVALID_ARG', 'bitrate')
    }
    return options
  }

  if (action === 'audioExtract') {
    const options = raw as AudioExtractOptions
    if (!options.start || !/^\d{2}:\d{2}:\d{2}(\.\d{1,2})?$/.test(options.start)) {
      throw makeError('E_INVALID_ARG', 'start')
    }
    if (!options.end || !/^\d{2}:\d{2}:\d{2}(\.\d{1,2})?$/.test(options.end)) {
      throw makeError('E_INVALID_ARG', 'end')
    }
    // 统一 HH:MM:SS 格式后可直接按字典序比较，开始不早于结束就没有可截取的区间
    if (options.start >= options.end) throw makeError('E_INVALID_ARG', 'start')
    return options
  }

  throw makeError('E_INVALID_ARG', 'action')
}

async function processOne(
  file: FileRow,
  options: MediaProcessOptions,
  signal: AbortSignal
): Promise<{ outputPath: string; bytes: number }> {
  const baseName = path.basename(file.path, path.extname(file.path))
  const targetDir = path.dirname(file.path)

  switch (options.action) {
    case 'convert':
      return transformImageFile(file.path, options)
    case 'compress':
      return compressImageFile(file.path, (options as ImageProcessOptions).quality)
    case 'edit':
      return transformImageFile(file.path, options)
    case 'videoConvert': {
      const outputPath = path.join(targetDir, `${baseName}-converted.mp4`)
      const args = buildVideoConvertCommand(file.path, outputPath, options)
      await runFfmpeg(args, signal)
      return statOutput(outputPath)
    }
    case 'videoCompress': {
      const outputPath = path.join(targetDir, `${baseName}-compressed.mp4`)
      const args = buildVideoCompressCommand(file.path, outputPath)
      await runFfmpeg(args, signal)
      return statOutput(outputPath)
    }
    case 'videoScreenshot': {
      const outputPath = path.join(targetDir, `${baseName}-screenshot.jpg`)
      const args = buildVideoScreenshotCommand(file.path, outputPath, (options as VideoScreenshotOptions).at)
      await runFfmpeg(args, signal)
      return statOutput(outputPath)
    }
    case 'audioConvert': {
      const options2 = options as AudioConvertOptions
      const ext = options2.format === 'wav' ? 'wav' : options2.format === 'flac' ? 'flac' : 'mp3'
      const outputPath = path.join(targetDir, `${baseName}-converted.${ext}`)
      const args = buildAudioConvertCommand(file.path, outputPath, options2)
      await runFfmpeg(args, signal)
      return statOutput(outputPath)
    }
    case 'audioCompress': {
      const outputPath = path.join(targetDir, `${baseName}-compressed.mp3`)
      const args = buildAudioCompressCommand(file.path, outputPath)
      await runFfmpeg(args, signal)
      return statOutput(outputPath)
    }
    case 'audioExtract': {
      const options2 = options as AudioExtractOptions
      // 截取走 -c:a copy，输出容器必须与源格式一致，否则 ffmpeg 会因编码不匹配失败
      const ext = path.extname(file.path).toLowerCase()
      const outputPath = path.join(targetDir, `${baseName}-extracted${ext}`)
      const args = buildAudioExtractCommand(file.path, outputPath, options2.start, options2.end)
      await runFfmpeg(args, signal)
      return statOutput(outputPath)
    }
    default:
      throw makeError('E_INVALID_ARG', 'action')
  }
}

async function statOutput(outputPath: string): Promise<{ outputPath: string; bytes: number }> {
  const stat = fs.statSync(outputPath)
  if (!stat.isFile() || stat.size === 0) throw makeError('E_VERIFY_FAILED', 'empty output')
  return { outputPath, bytes: stat.size }
}
