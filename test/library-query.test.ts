import { describe, expect, it } from 'vitest'
import { escapeLike, normalizeLibraryQuery } from '../src/main/library/query'

/** 项目里的 AppError 是普通对象而非 Error，这里统一取 code 做断言 */
function codeOf(action: () => unknown): string | null {
  try {
    action()
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? null
  }
}

describe('本地素材查询参数', () => {
  it('不传参数时给出默认分页，不把 undefined 带进 SQL', () => {
    expect(normalizeLibraryQuery(undefined)).toEqual({
      type: null,
      keyword: '',
      page: 1,
      pageSize: 50
    })
    expect(normalizeLibraryQuery({})).toEqual({ type: null, keyword: '', page: 1, pageSize: 50 })
  })

  it('类型只接受素材类型枚举', () => {
    expect(normalizeLibraryQuery({ type: 'image' }).type).toBe('image')
    expect(normalizeLibraryQuery({ type: 'video' }).type).toBe('video')
    expect(codeOf(() => normalizeLibraryQuery({ type: 'gif' }))).toBe('E_INVALID_ARG')
    expect(codeOf(() => normalizeLibraryQuery({ type: 1 }))).toBe('E_INVALID_ARG')
  })

  it('关键词去掉首尾空白，并且有长度上限', () => {
    expect(normalizeLibraryQuery({ keyword: '  山  ' }).keyword).toBe('山')
    expect(normalizeLibraryQuery({ keyword: '   ' }).keyword).toBe('')
    expect(normalizeLibraryQuery({ keyword: 'a'.repeat(100) }).keyword).toHaveLength(100)
    expect(codeOf(() => normalizeLibraryQuery({ keyword: 'a'.repeat(101) }))).toBe('E_INVALID_ARG')
    expect(codeOf(() => normalizeLibraryQuery({ keyword: 1 }))).toBe('E_INVALID_ARG')
  })

  it('分页参数必须是范围内的整数，避免 NaN 变成 OFFSET', () => {
    expect(normalizeLibraryQuery({ page: 2, pageSize: 200 }).page).toBe(2)
    for (const page of [0, -1, 1.5, Number.NaN, '2']) {
      expect(codeOf(() => normalizeLibraryQuery({ page }))).toBe('E_INVALID_ARG')
    }
    for (const pageSize of [0, 201, 2.5, '50']) {
      expect(codeOf(() => normalizeLibraryQuery({ pageSize }))).toBe('E_INVALID_ARG')
    }
  })
})

describe('LIKE 转义', () => {
  it('百分号、下划线与反斜杠按字面量匹配', () => {
    expect(escapeLike('100%')).toBe('100\\%')
    expect(escapeLike('a_b')).toBe('a\\_b')
    expect(escapeLike('c:\\tmp')).toBe('c:\\\\tmp')
    expect(escapeLike('普通文字')).toBe('普通文字')
  })
})
