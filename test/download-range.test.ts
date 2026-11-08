import { describe, expect, it } from 'vitest'
import {
  decideRange,
  parseContentRange,
  type HttpRangeMeta,
  type StoredMeta
} from '../src/main/download/range'

const STORED: StoredMeta = { etag: '"v1"', lastModified: null, totalBytes: 1000 }

function response(overrides: Partial<HttpRangeMeta>): HttpRangeMeta {
  return {
    status: 206,
    contentRangeStart: 0,
    contentRangeTotal: 1000,
    contentLength: 1000,
    etag: '"v1"',
    lastModified: null,
    ...overrides
  }
}

describe('Content-Range 解析', () => {
  it('解析正常区间与总大小', () => {
    expect(parseContentRange('bytes 100-199/1000')).toEqual({ start: 100, total: 1000 })
  })

  it('解析 416 的星号起始', () => {
    expect(parseContentRange('bytes */1000')).toEqual({ start: null, total: 1000 })
  })

  it('总大小未知时返回 total=null', () => {
    expect(parseContentRange('bytes 0-99/*')).toEqual({ start: 0, total: null })
  })

  it('格式不合法返回 null，不按 0 处理', () => {
    expect(parseContentRange('bytes=0-99/100')).toBeNull()
    expect(parseContentRange(null)).toBeNull()
  })
})

describe('Range 八分支决策', () => {
  it('206 且起点一致：追加写入', () => {
    expect(decideRange(300, STORED, response({ contentRangeStart: 300 }))).toEqual({
      kind: 'append',
      totalBytes: 1000
    })
  })

  it('206 但起点不符：截断重下', () => {
    expect(decideRange(300, STORED, response({ contentRangeStart: 200 }))).toEqual({
      kind: 'restart',
      reason: 'range-mismatch'
    })
  })

  it('200 忽略 Range：截断重下', () => {
    expect(
      decideRange(300, STORED, response({ status: 200, contentRangeStart: null }))
    ).toEqual({ kind: 'restart', reason: 'range-ignored' })
  })

  it('200 且本地为空：正常全量写入', () => {
    expect(
      decideRange(0, STORED, response({ status: 200, contentRangeStart: null, contentLength: 800 }))
    ).toEqual({ kind: 'append', totalBytes: 800 })
  })

  it('416 且本地已等于总大小：直接进入校验', () => {
    expect(
      decideRange(1000, STORED, response({ status: 416, contentRangeStart: null }))
    ).toEqual({ kind: 'complete', totalBytes: 1000 })
  })

  it('416 但本地未下完：截断重下', () => {
    expect(
      decideRange(300, STORED, response({ status: 416, contentRangeStart: null }))
    ).toEqual({ kind: 'restart', reason: 'range-out-of-bound' })
  })

  it('无 Content-Length：总大小未知但仍可追加', () => {
    expect(
      decideRange(0, { etag: null, lastModified: null, totalBytes: null }, response({
        status: 200,
        contentRangeStart: null,
        contentRangeTotal: null,
        contentLength: null
      }))
    ).toEqual({ kind: 'append', totalBytes: null })
  })

  it('ETag 不一致：源文件已更新，截断重下', () => {
    expect(decideRange(300, STORED, response({ contentRangeStart: 300, etag: '"v2"' }))).toEqual({
      kind: 'restart',
      reason: 'source-updated'
    })
  })

  it('没有 ETag 时用 Last-Modified 判断源文件更新', () => {
    const stored: StoredMeta = { etag: null, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT', totalBytes: 1000 }
    expect(
      decideRange(300, stored, response({
        contentRangeStart: 300,
        etag: null,
        lastModified: 'Tue, 02 Jan 2024 00:00:00 GMT'
      }))
    ).toEqual({ kind: 'restart', reason: 'source-updated' })
  })

  it('总大小与库中不一致也视为源文件更新', () => {
    expect(
      decideRange(300, STORED, response({ contentRangeStart: 300, contentRangeTotal: 2000 }))
    ).toEqual({ kind: 'restart', reason: 'source-updated' })
  })

  it('本地为 0 时不因 ETag 变化白跑一次截断', () => {
    expect(
      decideRange(0, STORED, response({ status: 200, contentRangeStart: null, etag: '"v2"' }))
    ).toEqual({ kind: 'append', totalBytes: 1000 })
  })
})
