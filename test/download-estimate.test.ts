import { describe, expect, it } from 'vitest'
import { summarizeEstimate } from '../src/main/download/estimate'

describe('批量下载体量预估', () => {
  it('全部大小已知时求和', () => {
    expect(
      summarizeEstimate([{ sizeBytes: 1024 }, { sizeBytes: 2048 }, { sizeBytes: 4096 }])
    ).toEqual({ count: 3, bytes: 7168 })
  })

  it('任一条大小未知就整体返回 null，不用已知部分冒充总数', () => {
    expect(summarizeEstimate([{ sizeBytes: 1024 }, { sizeBytes: null }])).toEqual({
      count: 2,
      bytes: null
    })
  })

  it('0 字节与负数按未知处理', () => {
    expect(summarizeEstimate([{ sizeBytes: 0 }])).toEqual({ count: 1, bytes: null })
    expect(summarizeEstimate([{ sizeBytes: -1 }])).toEqual({ count: 1, bytes: null })
    expect(summarizeEstimate([{ sizeBytes: Number.NaN }])).toEqual({ count: 1, bytes: null })
  })

  it('空列表返回 0 与 null，由调用方决定是否展示', () => {
    expect(summarizeEstimate([])).toEqual({ count: 0, bytes: null })
  })
})
