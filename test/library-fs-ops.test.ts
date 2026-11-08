import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { assertMovableDir, assertPathLength, planRename, readIds } from '../src/main/library/fs-ops'

/** 项目里的 AppError 是普通对象而非 Error，统一取 code 做断言 */
function codeOf(action: () => unknown): string | null {
  try {
    action()
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? null
  }
}

describe('重命名计划', () => {
  const source = 'D:\\素材\\cat.jpg'

  it('只给主体名时保留原扩展名', () => {
    expect(planRename(source, 'dog')).toEqual({
      from: source,
      to: 'D:\\素材\\dog.jpg',
      fileName: 'dog.jpg'
    })
  })

  it('输入带相同扩展名时剥掉再拼回，不产生双扩展名', () => {
    expect(planRename(source, 'dog.JPG').fileName).toBe('dog.jpg')
  })

  it('扩展名不一致时整体当主体名，改不掉真实类型', () => {
    // 用户输入 photo.exe 得到 photo.exe.jpg，而不是可执行文件
    expect(planRename(source, 'photo.exe').fileName).toBe('photo.exe.jpg')
  })

  it('只改大小写是允许的', () => {
    expect(planRename(source, 'CAT').fileName).toBe('CAT.jpg')
  })

  it('与原名完全相同会被拒绝', () => {
    expect(codeOf(() => planRename(source, 'cat'))).toBe('E_INVALID_ARG')
  })

  it('非法字符、结尾点、保留设备名、超长、空值都拒绝', () => {
    // 首尾空白会被 trim 掉再校验，所以「end 」最终是合法名 end.jpg，不在此列
    for (const bad of ['a/b', 'a\\b', 'a:b', 'a?b', 'end.', 'con', 'COM1', '', '   ']) {
      expect(codeOf(() => planRename(source, bad))).toBe('E_INVALID_ARG')
    }
    expect(codeOf(() => planRename(source, 'a'.repeat(121)))).toBe('E_INVALID_ARG')
    expect(codeOf(() => planRename(source, 123))).toBe('E_INVALID_ARG')
  })

  it('没有扩展名的文件也能改名', () => {
    expect(planRename('D:\\素材\\README', '说明').fileName).toBe('说明')
  })
})

describe('移动目标目录校验', () => {
  it('真实存在的普通目录放行', () => {
    expect(assertMovableDir(os.tmpdir())).toBeTruthy()
  })

  it('不存在的目录、相对路径、非字符串都拒绝', () => {
    expect(codeOf(() => assertMovableDir('D:\\绝对不存在的目录-9f3a'))).toBe('E_DIR_FORBIDDEN')
    expect(codeOf(() => assertMovableDir('.\\素材'))).toBe('E_DIR_FORBIDDEN')
    expect(codeOf(() => assertMovableDir(null))).toBe('E_DIR_FORBIDDEN')
    expect(codeOf(() => assertMovableDir('   '))).toBe('E_DIR_FORBIDDEN')
  })

  it('盘符根与系统目录拒绝', () => {
    expect(codeOf(() => assertMovableDir('C:\\'))).toBe('E_DIR_FORBIDDEN')
    expect(codeOf(() => assertMovableDir('C:\\Windows'))).toBe('E_DIR_FORBIDDEN')
    expect(codeOf(() => assertMovableDir('C:\\Windows\\System32'))).toBe('E_DIR_FORBIDDEN')
    expect(codeOf(() => assertMovableDir('C:\\Users'))).toBe('E_DIR_FORBIDDEN')
  })
})

describe('批量 id 校验', () => {
  it('去重并保持顺序', () => {
    expect(readIds({ ids: [3, 1, 3, 2] })).toEqual([3, 1, 2])
  })

  it('空数组、超 200、非整数、非数字都拒绝', () => {
    expect(codeOf(() => readIds({ ids: [] }))).toBe('E_INVALID_ARG')
    expect(codeOf(() => readIds({ ids: Array.from({ length: 201 }, (_, i) => i + 1) }))).toBe(
      'E_INVALID_ARG'
    )
    expect(codeOf(() => readIds({ ids: [1.5] }))).toBe('E_INVALID_ARG')
    expect(codeOf(() => readIds({ ids: ['1'] }))).toBe('E_INVALID_ARG')
    expect(codeOf(() => readIds({ ids: [0] }))).toBe('E_INVALID_ARG')
    expect(codeOf(() => readIds({}))).toBe('E_INVALID_ARG')
  })

  it('路径超长拒绝', () => {
    expect(codeOf(() => assertPathLength(`C:\\${'a'.repeat(300)}`))).toBe('E_INVALID_ARG')
    expect(codeOf(() => assertPathLength('C:\\ok.jpg'))).toBeNull()
  })
})
