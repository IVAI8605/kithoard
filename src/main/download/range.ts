/**
 * §5.5 Range 响应分支的纯函数实现。
 * 这里不碰网络也不碰磁盘：引擎把响应头解析成结构体传进来，由本函数决定「追加、重下、完成」。
 * 抽成纯函数是为了让八个分支能被穷举单测，而不用起服务器、造大文件。
 */

/** 服务器响应中与本决策相关的字段；无法解析的一律 null，不猜 */
export interface HttpRangeMeta {
  status: number
  /** Content-Range 的起始字节；`bytes * /1000` 时为 null */
  contentRangeStart: number | null
  /** Content-Range 给出的总大小；未知为 null */
  contentRangeTotal: number | null
  /** Content-Length；chunked 响应为 null */
  contentLength: number | null
  etag: string | null
  lastModified: string | null
}

/** 库中上一次下载留下的校验信息，用于判断源文件是否已更新 */
export interface StoredMeta {
  etag: string | null
  lastModified: string | null
  totalBytes: number | null
}

export type RangeRestartReason =
  | 'range-mismatch'
  | 'range-ignored'
  | 'range-out-of-bound'
  | 'source-updated'

export type RangeDecision =
  | { kind: 'append'; totalBytes: number | null }
  | { kind: 'restart'; reason: RangeRestartReason }
  | { kind: 'complete'; totalBytes: number | null }

/** 解析 `bytes 100-199/1000` 与 `bytes * /1000`；格式不对返回 null，不按 0 处理 */
export function parseContentRange(
  value: string | null
): { start: number | null; total: number | null } | null {
  if (!value) return null
  const match = /^bytes\s+(?:(\d+)-\d+|\*)\/(\d+|\*)$/i.exec(value.trim())
  if (!match) return null
  const start = match[1] === undefined ? null : Number(match[1])
  const total = match[2] === '*' ? null : Number(match[2])
  if (start !== null && !Number.isSafeInteger(start)) return null
  if (total !== null && !Number.isSafeInteger(total)) return null
  return { start, total }
}

/** ETag 优先；没有 ETag 时退回 Last-Modified。两者都缺就无法判断，视为未更新 */
function sourceChanged(stored: StoredMeta, response: HttpRangeMeta): boolean {
  if (stored.etag && response.etag) return stored.etag !== response.etag
  if (stored.lastModified && response.lastModified) {
    return stored.lastModified !== response.lastModified
  }
  return false
}

/**
 * 决策顺序按「先判断源文件是否换过，再看状态码」：
 * 源文件变了，任何区间都不再可信，必须先截断重下，否则接上的会是旧文件的前半段。
 */
export function decideRange(
  localBytes: number,
  stored: StoredMeta,
  response: HttpRangeMeta
): RangeDecision {
  const responseTotal = response.contentRangeTotal

  if (localBytes > 0) {
    if (sourceChanged(stored, response)) return { kind: 'restart', reason: 'source-updated' }
    // 总大小变小或变大都说明源文件换过；只在两边都有值时才比较，缺失不算变化
    if (
      stored.totalBytes !== null &&
      responseTotal !== null &&
      stored.totalBytes !== responseTotal
    ) {
      return { kind: 'restart', reason: 'source-updated' }
    }
  }

  if (response.status === 416) {
    const total = responseTotal ?? stored.totalBytes
    // 本地已经等于总大小：说明上次其实下完了，只是没来得及校验
    if (total !== null && localBytes === total) return { kind: 'complete', totalBytes: total }
    return { kind: 'restart', reason: 'range-out-of-bound' }
  }

  if (response.status === 206) {
    if (response.contentRangeStart === localBytes) {
      return { kind: 'append', totalBytes: responseTotal ?? stored.totalBytes }
    }
    return { kind: 'restart', reason: 'range-mismatch' }
  }

  if (response.status === 200) {
    // 本地已有字节却拿到 200：服务器忽略了 Range（跨域重定向也会剥掉 Range）
    if (localBytes > 0) return { kind: 'restart', reason: 'range-ignored' }
    // 从 0 开始的全量响应；没有 Content-Length 时总大小未知，界面不显示百分比
    return { kind: 'append', totalBytes: response.contentLength }
  }

  // 其他状态码由引擎在调用前按错误码处理，这里不兜底放行
  return { kind: 'restart', reason: 'range-mismatch' }
}
