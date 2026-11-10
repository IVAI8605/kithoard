import fs from 'node:fs'
import path from 'node:path'
import { CHANNELS } from '@shared/channels'
import { makeError, isAppError, type AppError, type ErrorCode } from '@shared/errors'
import type { AssetType, DownloadState } from '@shared/types'
import { getDb } from '../db'
import { log } from '../log'
import { judgeFile } from '../safety/magic'
import { ensureDir, moveFile, uniqueQuarantinePath } from '../safety/quarantine'
import { getPlainSetting } from '../settings'
import { normalizePath } from './naming'
import { decideRange, parseContentRange, type HttpRangeMeta } from './range'
import { isTerminal, nextState, type DownloadEvent } from './task'

/** §6.2：进度事件 500 ms 合并一次，避免每收一个 TCP 包就推一次 */
const PROGRESS_INTERVAL_MS = 500
/** §5.6：字节进度只在每 5 秒或每 8 MB（先到者）落库 */
const FLUSH_INTERVAL_MS = 5_000
const FLUSH_BYTES = 8 * 1024 * 1024
/** §5.5 下载超时：连接 15 s，读空闲 60 s */
const CONNECT_TIMEOUT_MS = 15_000
const IDLE_TIMEOUT_MS = 60_000
/** §5.5：连续 3 次无字节增长判为卡死 */
const MAX_STALL_ROUNDS = 3
/** 单任务最多重新协商几次区间，防止异常服务器把循环拖死；正常续传也计入 */
const MAX_ROUNDS = 20

interface TaskRow {
  id: string
  asset_id: number | null
  asset_type: AssetType | null
  /** 素材的来源与远程 id：下载前按 id 续期直链需要这两项 */
  source_id: string | null
  remote_id: string | null
  state: DownloadState
  target_path: string
  url: string
  total_bytes: number | null
  received_bytes: number
  etag: string | null
  last_modified: string | null
}

interface TaskRuntime {
  row: TaskRow
  controller: AbortController
  /** 中止原因：区分用户暂停/取消、超时与退出，不能一律当网络错误 */
  abortReason: 'pause' | 'cancel' | 'shutdown' | 'timeout' | null
  received: number
  totalBytes: number | null
  lastEmitAt: number
  lastFlushAt: number
  lastFlushBytes: number
  /** 本次是否尝试过按 id 续期直链；400 只有在这时才按「链接过期」解释 */
  refreshAttempted: boolean
  /** 续期失败的原因码，用于让最终错误区分「链接过期」与「API 不可达 / Key 失效」 */
  refreshError: ErrorCode | null
}

type AttemptOutcome =
  | { kind: 'completed'; totalBytes: number | null }
  | { kind: 'retry'; received: number; grew: boolean }

interface Session {
  runtime: TaskRuntime
  stopKind: 'pause' | 'cancel' | null
  done: Promise<void>
}

export interface DownloadEngine {
  /** 取队列：并发未满就继续拿 queued 任务；调小并发时已在跑的不被打断 */
  pump(): void
  /** 中止在跑任务；返回 false 表示该任务当前没在跑，由调用方自行收尾 */
  stop(taskId: string, kind: 'pause' | 'cancel'): Promise<boolean>
  /** 退出前同步中止所有写入，之后引擎不再碰数据库 */
  shutdown(): void
}

export function createDownloadEngine(deps: {
  emit: (channel: string, payload: unknown) => void
  quarantineDir: string
  /** 下载前的直链续期；返回 null 表示不需要续期。失败由引擎兜底回退，不上抛 */
  refreshUrl?: (
    target: { sourceId: string; remoteId: string; type: AssetType },
    signal: AbortSignal
  ) => Promise<string | null>
}): DownloadEngine {
  const running = new Map<string, Session>()
  let closed = false

  function pump(): void {
    if (closed) return
    const limit = readConcurrency()
    while (running.size < limit) {
      const row = claimNext()
      if (!row) return
      start(row)
    }
  }

  function claimNext(): TaskRow | null {
    const db = getDb()
    const row = db
      .prepare(
        `SELECT d.id, d.asset_id, a.type AS asset_type, a.source_id, a.remote_id,
                d.state, d.target_path, d.url,
                d.total_bytes, d.received_bytes, d.etag, d.last_modified
           FROM downloads d
           LEFT JOIN assets a ON a.id = d.asset_id
          WHERE d.state = 'queued'
          ORDER BY d.sort_order, d.created_at
          LIMIT 1`
      )
      .get() as TaskRow | undefined
    if (!row) return null
    // 带条件更新：即使将来出现并发入口，也只有一个调用能真正抢到这条任务
    const result = db
      .prepare(`UPDATE downloads SET state = 'downloading', error_code = NULL, updated_at = ? WHERE id = ? AND state = 'queued'`)
      .run(Date.now(), row.id)
    if (result.changes !== 1) return null
    const next: TaskRow = { ...row, state: 'downloading' }
    emitState(next.id, 'downloading', next.received_bytes, next.total_bytes, null)
    return next
  }

  function start(row: TaskRow): void {
    const runtime: TaskRuntime = {
      row,
      controller: new AbortController(),
      abortReason: null,
      received: partSize(row.target_path) ?? row.received_bytes,
      totalBytes: row.total_bytes,
      lastEmitAt: 0,
      lastFlushAt: Date.now(),
      lastFlushBytes: partSize(row.target_path) ?? row.received_bytes,
      refreshAttempted: false,
      refreshError: null
    }
    const session: Session = { runtime, stopKind: null, done: Promise.resolve() }
    running.set(row.id, session)
    session.done = runTask(session)
      .catch((error: unknown) => {
        // runTask 内部已兜底；这里只防不可预见的异常把进程带崩
        log.error(`download task crashed: ${row.id} ${describe(error)}`)
      })
      .finally(() => {
        running.delete(row.id)
        pump()
      })
  }

  async function runTask(session: Session): Promise<void> {
    const rt = session.runtime
    let stall = 0

    try {
      // 续期放在最前面：拿到新链接后再发下载请求，续期本身失败也要继续尝试库内链接
      await prepareUrl(rt)
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const outcome = await attempt(rt)
        if (outcome.kind === 'completed') {
          await verifyAndFinish(rt)
          return
        }
        if (outcome.grew) stall = 0
        else stall += 1
        if (stall >= MAX_STALL_ROUNDS) throw makeError('E_NETWORK', 'no byte growth')
      }
      throw makeError('E_NETWORK', 'too many range rounds')
    } catch (error) {
      if (closed || session.stopKind) return
      failTask(rt, mapError(error))
    }
  }

  /**
   * 下载前按 id 续期直链（§7.11-A）。续期是「尽力而为」：
   * 失败只记原因并回退库内链接，不阻断下载；最终失败时把原因带进错误码，
   * 避免界面只显示一个分不清「链接过期」还是「API 不可达」的 HTTP 状态。
   */
  async function prepareUrl(rt: TaskRuntime): Promise<void> {
    if (!deps.refreshUrl || !rt.row.source_id || !rt.row.remote_id) return
    rt.refreshAttempted = true
    try {
      const url = await deps.refreshUrl(
        {
          sourceId: rt.row.source_id,
          remoteId: rt.row.remote_id,
          type: rt.row.asset_type ?? 'image'
        },
        rt.controller.signal
      )
      if (url) rt.row.url = url
    } catch (error) {
      rt.refreshError = isAppError(error) ? error.code : 'E_NETWORK'
      log.warn(`download url refresh failed: ${rt.row.id} code=${rt.refreshError}`)
    }
  }

  /** 发一次请求并把响应体写进 `.part`；返回值只描述「这一轮之后处于什么局面」 */
  async function attempt(rt: TaskRuntime): Promise<AttemptOutcome> {
    const response = await requestOnce(rt)
    const meta = readResponseMeta(response)

    if (response.status !== 200 && response.status !== 206 && response.status !== 416) {
      await discard(response)
      throw downloadStatusError(response.status, {
        attempted: rt.refreshAttempted,
        errorCode: rt.refreshError
      })
    }

    const decision = decideRange(
      rt.received,
      {
        etag: rt.row.etag,
        lastModified: rt.row.last_modified,
        totalBytes: rt.row.total_bytes
      },
      meta
    )
    // 总大小可能来自三处：Content-Range、200 的 Content-Length、或沿用库中旧值；
    // 源文件换过时优先用本次响应给出的新总大小，否则收尾校验会拿旧值误判
    const total =
      decision.kind === 'append' || decision.kind === 'complete'
        ? decision.totalBytes
        : meta.contentRangeTotal ?? (meta.status === 200 ? meta.contentLength : rt.totalBytes)
    applyMeta(rt, meta, total)

    if (decision.kind === 'complete') {
      await discard(response)
      rt.totalBytes = decision.totalBytes ?? rt.totalBytes
      return { kind: 'completed', totalBytes: rt.totalBytes }
    }

    if (decision.kind === 'restart') {
      // 200 的响应体本来就是从 0 开始的完整文件，截断后可以直接用，省一次请求
      const canReuse = meta.status === 200
      if (!canReuse) await discard(response)
      truncatePart(rt.row.target_path)
      rt.received = 0
      if (!canReuse) return { kind: 'retry', received: 0, grew: false }
    } else {
      rt.totalBytes = decision.totalBytes ?? rt.totalBytes
    }

    const written = await streamBody(rt, response)
    if (rt.totalBytes !== null) {
      if (rt.received > rt.totalBytes) throw makeError('E_VERIFY_FAILED', 'oversized')
      if (rt.received === rt.totalBytes) {
        return { kind: 'completed', totalBytes: rt.totalBytes }
      }
      return { kind: 'retry', received: rt.received, grew: written > 0 }
    }
    // 总大小未知（chunked）：响应正常结束即视为完成，不做总字节校验
    return { kind: 'completed', totalBytes: null }
  }

  async function requestOnce(rt: TaskRuntime): Promise<Response> {
    const headers: Record<string, string> = {}
    if (rt.received > 0) {
      headers['Range'] = `bytes=${rt.received}-`
      // If-Range 用上次响应的原样校验值；弱 ETag 不能用于 If-Range，退回 Last-Modified
      if (rt.row.etag && !rt.row.etag.startsWith('W/')) headers['If-Range'] = rt.row.etag
      else if (rt.row.last_modified) headers['If-Range'] = rt.row.last_modified
    }

    const timer = setTimeout(() => {
      rt.abortReason = 'timeout'
      rt.controller.abort()
    }, CONNECT_TIMEOUT_MS)
    try {
      return await fetch(rt.row.url, {
        headers,
        signal: rt.controller.signal,
        redirect: 'follow'
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /** 把响应体增量写入 `.part`，返回本次真正写入的字节数 */
  async function streamBody(rt: TaskRuntime, response: Response): Promise<number> {
    const partPath = partPathOf(rt.row)
    const stream = fs.createWriteStream(partPath, { flags: rt.received > 0 ? 'a' : 'w' })
    // 写失败既会进 write 回调也会触发 error 事件；先挂一个空监听，避免未处理的 error 让进程崩掉
    stream.on('error', () => undefined)
    let idleTimer: NodeJS.Timeout | null = null
    let written = 0

    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        rt.abortReason = 'timeout'
        rt.controller.abort()
      }, IDLE_TIMEOUT_MS)
    }

    try {
      resetIdle()
      const body = response.body
      if (!body) {
        await closeStream(stream)
        return written
      }
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        resetIdle()
        const buffer = Buffer.from(chunk)
        rt.received += buffer.length
        written += buffer.length
        await writeChunk(stream, buffer)
        emitProgress(rt)
        maybeFlush(rt)
      }
      await closeStream(stream)
      return written
    } catch (error) {
      stream.destroy()
      throw error
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
    }
  }

  async function verifyAndFinish(rt: TaskRuntime): Promise<void> {
    const partPath = partPathOf(rt.row)
    const size = statSize(partPath)
    if (size === null) throw makeError('E_TEMP_MISSING')
    if (rt.totalBytes !== null && size !== rt.totalBytes) {
      throw makeError('E_VERIFY_FAILED', 'size mismatch')
    }

    // §5.3 禁止跳过 verifying；先做大小、可读性与魔数判定（§7.4-6）
    const verifying = transition(rt.row.id, 'verify', {
      receivedBytes: size,
      totalBytes: rt.totalBytes
    })
    emitState(rt.row.id, verifying, size, rt.totalBytes, null)

    const judgement = judgeFile(readHead(partPath), expectedType(rt.row))
    if (!judgement.ok) {
      quarantineAndBlock(rt, size, judgement.reason ?? '文件格式与声明不符')
      return
    }

    if (fs.existsSync(rt.row.target_path)) {
      // 不覆盖任何已有文件；保留 .part，等用户决定重试或取消
      throw makeError('E_FILE_IN_USE', rt.row.target_path)
    }
    try {
      fs.renameSync(partPath, rt.row.target_path)
    } catch (error) {
      throw makeError('E_FILE_IN_USE', describe(error))
    }

    const finalSize = statSize(rt.row.target_path) ?? size
    const now = Date.now()
    const db = getDb()
    try {
      db.transaction(() => {
        db.prepare(
          `UPDATE downloads
              SET state = 'completed', received_bytes = ?, total_bytes = ?, error_code = NULL, updated_at = ?
            WHERE id = ?`
        ).run(finalSize, rt.totalBytes ?? finalSize, now, rt.row.id)
        db.prepare(
          `INSERT INTO local_files (asset_id, download_id, path, status, size_bytes, created_at, updated_at)
           VALUES (?, ?, ?, 'present', ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             download_id = excluded.download_id,
             status = 'present',
             size_bytes = excluded.size_bytes,
             updated_at = excluded.updated_at`
        ).run(rt.row.asset_id, rt.row.id, normalizePath(rt.row.target_path), finalSize, now, now)
      })()
    } catch (error) {
      // rename 已完成但记账失败：留在 verifying，由启动恢复按「目标文件已就位」补登，不谎报完成
      log.error(`download finish db error: ${rt.row.id} ${describe(error)}`)
      return
    }
    emitState(rt.row.id, 'completed', finalSize, rt.totalBytes ?? finalSize, null)
    log.info(`download completed: ${rt.row.id} ${finalSize} bytes`)
  }

  /**
   * 判定有风险时把 `.part` 移入隔离区（§5.3 verifying → quarantined）。
   * 不删除、不改名到目标路径；用户可在隔离区手动恢复或放弃（移入回收站）。
   */
  function quarantineAndBlock(rt: TaskRuntime, size: number, reason: string): void {
    const state = nextState('verifying', 'quarantine')
    ensureDir(deps.quarantineDir)
    const quarantinePath = uniqueQuarantinePath(deps.quarantineDir, rt.row.target_path)
    moveFile(partPathOf(rt.row), quarantinePath)

    const now = Date.now()
    const db = getDb()
    try {
      db.transaction(() => {
        db.prepare(
          `UPDATE downloads
              SET state = ?, received_bytes = ?, total_bytes = ?, error_code = 'E_RISK_FILE', updated_at = ?
            WHERE id = ?`
        ).run(state, size, rt.totalBytes ?? size, now, rt.row.id)
        db.prepare(
          `INSERT INTO local_files (asset_id, download_id, path, status, size_bytes, created_at, updated_at)
           VALUES (?, ?, ?, 'quarantined', ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             download_id = excluded.download_id,
             status = 'quarantined',
             size_bytes = excluded.size_bytes,
             updated_at = excluded.updated_at`
        ).run(rt.row.asset_id, rt.row.id, normalizePath(quarantinePath), size, now, now)
        db.prepare(
          'INSERT INTO quarantine (download_id, path, reason, created_at) VALUES (?, ?, ?, ?)'
        ).run(rt.row.id, normalizePath(quarantinePath), reason, now)
      })()
    } catch (error) {
      log.error(`download quarantine db error: ${rt.row.id} ${describe(error)}`)
      return
    }
    emitState(rt.row.id, state, size, rt.totalBytes ?? size, 'E_RISK_FILE')
    log.warn(`download quarantined: ${rt.row.id} ${reason}`)
  }

  function failTask(rt: TaskRuntime, code: ErrorCode): void {
    try {
      const db = getDb()
      const row = db.prepare('SELECT state FROM downloads WHERE id = ?').get(rt.row.id) as
        | { state: DownloadState }
        | undefined
      if (!row || isTerminal(row.state)) return
      // verifying 只能走 verify-fail，直接 fail 会被状态机拒绝
      const event: DownloadEvent = row.state === 'verifying' ? 'verify-fail' : 'fail'
      const state = transition(rt.row.id, event, {
        receivedBytes: rt.received,
        errorCode: code
      })
      emitState(rt.row.id, state, rt.received, rt.totalBytes, code)
      log.warn(`download failed: ${rt.row.id} ${code}`)
    } catch (error) {
      log.error(`download fail-task error: ${rt.row.id} ${describe(error)}`)
    }
  }

  function applyMeta(rt: TaskRuntime, meta: HttpRangeMeta, total: number | null): void {
    if (meta.etag) rt.row.etag = meta.etag
    if (meta.lastModified) rt.row.last_modified = meta.lastModified
    // 本次响应没给总大小时写 NULL，而不是沿用旧值：源文件可能已经变得更小
    rt.totalBytes = total
    rt.row.total_bytes = total
    if (closed) return
    getDb()
      .prepare('UPDATE downloads SET etag = ?, last_modified = ?, total_bytes = ? WHERE id = ?')
      .run(rt.row.etag, rt.row.last_modified, rt.totalBytes, rt.row.id)
  }

  function emitProgress(rt: TaskRuntime): void {
    if (closed) return
    const now = Date.now()
    if (now - rt.lastEmitAt < PROGRESS_INTERVAL_MS) return
    rt.lastEmitAt = now
    deps.emit(CHANNELS.downloadProgress, {
      taskId: rt.row.id,
      receivedBytes: rt.received,
      totalBytes: rt.totalBytes
    })
  }

  function maybeFlush(rt: TaskRuntime): void {
    if (closed) return
    const now = Date.now()
    const grown = rt.received - rt.lastFlushBytes
    if (now - rt.lastFlushAt < FLUSH_INTERVAL_MS && grown < FLUSH_BYTES) return
    rt.lastFlushAt = now
    rt.lastFlushBytes = rt.received
    getDb().prepare('UPDATE downloads SET received_bytes = ? WHERE id = ?').run(rt.received, rt.row.id)
  }

  function emitState(
    taskId: string,
    state: DownloadState,
    receivedBytes: number,
    totalBytes: number | null,
    errorCode: string | null
  ): void {
    if (closed) return
    deps.emit(CHANNELS.downloadState, { taskId, state, receivedBytes, totalBytes, errorCode })
  }

  async function stop(taskId: string, kind: 'pause' | 'cancel'): Promise<boolean> {
    const session = running.get(taskId)
    if (!session) return false
    session.stopKind = kind
    session.runtime.abortReason = kind
    session.runtime.controller.abort()
    await session.done.catch(() => undefined)
    if (closed) return true

    const db = getDb()
    const row = db
      .prepare('SELECT state, target_path, received_bytes, total_bytes FROM downloads WHERE id = ?')
      .get(taskId) as
      | { state: DownloadState; target_path: string; received_bytes: number; total_bytes: number | null }
      | undefined
    if (!row || isTerminal(row.state)) return true

    if (kind === 'pause' && row.state === 'downloading') {
      // 暂停后进度以磁盘为准：DB 里的 received_bytes 可能落后于 .part 实际大小
      const bytes = statSize(row.target_path) ?? row.received_bytes
      const state = transition(taskId, 'pause', { receivedBytes: bytes })
      emitState(taskId, state, bytes, row.total_bytes, null)
    } else if (kind === 'cancel') {
      const state = transition(taskId, 'cancel', { receivedBytes: row.received_bytes })
      removePart(row.target_path)
      emitState(taskId, state, row.received_bytes, row.total_bytes, null)
    }
    return true
  }

  function transition(
    taskId: string,
    event: DownloadEvent,
    patch: { receivedBytes?: number; totalBytes?: number | null; errorCode?: string | null } = {}
  ): DownloadState {
    const db = getDb()
    const row = db.prepare('SELECT state FROM downloads WHERE id = ?').get(taskId) as
      | { state: DownloadState }
      | undefined
    if (!row) throw makeError('E_INVALID_ARG', 'taskId')
    const next = nextState(row.state, event)

    const fields: string[] = ['state = ?', 'updated_at = ?']
    const values: Array<string | number | null> = [next, Date.now()]
    if (patch.receivedBytes !== undefined) {
      fields.push('received_bytes = ?')
      values.push(patch.receivedBytes)
    }
    if (patch.totalBytes !== undefined) {
      fields.push('total_bytes = ?')
      values.push(patch.totalBytes)
    }
    if (patch.errorCode !== undefined) {
      fields.push('error_code = ?')
      values.push(patch.errorCode)
    }
    values.push(taskId)
    db.prepare(`UPDATE downloads SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    return next
  }

  return {
    pump,
    stop,
    shutdown() {
      closed = true
      for (const session of running.values()) {
        session.stopKind = 'pause'
        session.runtime.abortReason = 'shutdown'
        session.runtime.controller.abort()
      }
    }
  }
}

/** §5.2 download.concurrency 默认 3，范围 1–5；调小只影响「还取不取新任务」 */
function readConcurrency(): number {
  const raw = getPlainSetting('download.concurrency')
  const value = raw === null ? Number.NaN : Number(raw)
  if (!Number.isFinite(value)) return 3
  return Math.min(5, Math.max(1, Math.trunc(value)))
}

/** §5.2 download.autoStart：只控制新入队任务是否立即开始，与崩溃恢复询问无关 */
export function isAutoStartEnabled(): boolean {
  const raw = getPlainSetting('download.autoStart')
  if (raw === null) return true
  return !(raw === 'false' || raw === '0')
}

function partPathOf(row: { target_path: string }): string {
  return `${row.target_path}.part`
}

/** 只读文件头 64 字节；读不了按校验失败处理，不放行 */
function readHead(filePath: string): Uint8Array {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(64)
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
    if (read === 0) throw makeError('E_VERIFY_FAILED', 'empty file')
    return buffer.subarray(0, read)
  } catch (error) {
    if (isAppError(error)) throw error
    throw makeError('E_VERIFY_FAILED', 'unreadable')
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** 素材记录被删后只能按目标扩展名推断，避免把图片误判成视频而白白隔离 */
function expectedType(row: TaskRow): AssetType {
  if (row.asset_type) return row.asset_type
  const ext = path.extname(row.target_path).slice(1).toLowerCase()
  if (['mp4', 'webm', 'mov', 'mkv'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(ext)) return 'audio'
  if (['ttf', 'otf', 'woff', 'woff2'].includes(ext)) return 'font'
  return 'image'
}

function partSize(targetPath: string): number | null {
  return statSize(`${targetPath}.part`)
}

function statSize(filePath: string): number | null {
  try {
    const info = fs.statSync(filePath)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

function truncatePart(targetPath: string): void {
  try {
    fs.truncateSync(`${targetPath}.part`, 0)
  } catch {
    // 文件不存在时无需截断，后续写入会以 'w' 方式新建
  }
}

/** §5.8：`.part` 是应用临时文件，允许物理删除 */
function removePart(targetPath: string): void {
  try {
    fs.unlinkSync(`${targetPath}.part`)
  } catch {
    // 已经不存在说明目标已达成
  }
}

function readResponseMeta(response: Response): HttpRangeMeta {
  const range = parseContentRange(response.headers.get('content-range'))
  const length = response.headers.get('content-length')
  return {
    status: response.status,
    contentRangeStart: range?.start ?? null,
    contentRangeTotal: range?.total ?? null,
    contentLength: length && /^\d+$/.test(length) ? Number(length) : null,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified')
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // 丢弃响应体失败不影响后续重新请求
  }
}

function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end((error?: Error | null) => (error ? reject(error) : resolve()))
  })
}

/**
 * 按写回调逐块等待：write 返回 false 时用 drain 也可以，但两者同时监听 error 更啰嗦；
 * 逐块等待虽然牺牲一点吞吐，但磁盘写失败能立即抛出，不会被吞成「卡住不动」。
 */
function writeChunk(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()))
  })
}

function mapHttpStatus(status: number): ErrorCode {
  if (status === 429) return 'E_RATE_LIMITED'
  if (status === 401 || status === 403) return 'E_AUTH_REQUIRED'
  if (status >= 500) return 'E_SOURCE_DOWN'
  return 'E_NETWORK'
}

/**
 * 把 HTTP 状态翻译成用户能看懂的错误码。
 * 400 在签名直链场景下就是「链接已过期」；如果刚试过续期，就把续期的失败原因
 * （断网 / Key 失效 / 限额）作为错误码，让界面能区分到底是链接过期还是接口不可达。
 * 抽成纯函数是为了能直接单测这层口径。
 */
export function downloadStatusError(
  status: number,
  refresh: { attempted: boolean; errorCode: ErrorCode | null }
): AppError {
  if (status === 400 && refresh.attempted) {
    return makeError(refresh.errorCode ?? 'E_LINK_EXPIRED', 'signed url expired')
  }
  return makeError(mapHttpStatus(status), `HTTP ${status}`)
}

function mapError(error: unknown): ErrorCode {
  if (isAppError(error)) return error.code
  const record = error as { code?: unknown; name?: unknown }
  if (record?.code === 'ENOSPC') return 'E_DISK_FULL'
  if (record?.code === 'EACCES' || record?.code === 'EPERM') return 'E_DIR_UNWRITABLE'
  if (record?.code === 'EBUSY') return 'E_FILE_IN_USE'
  // fetch 的网络异常是 TypeError；主动中止是 AbortError，两者都按网络问题处理
  if (record?.name === 'AbortError' || error instanceof TypeError) return 'E_NETWORK'
  return 'E_UNKNOWN'
}

function describe(error: unknown): string {
  if (isAppError(error)) return `${error.code}`
  return error instanceof Error ? error.message : String(error)
}
