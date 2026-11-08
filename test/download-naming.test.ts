import { describe, expect, it } from 'vitest'
import {
  buildTargetPath,
  extFromUrl,
  normalizePath,
  sanitizeBaseName
} from '../src/main/download/naming'

describe('路径规范化', () => {
  it('盘符转小写并把正斜杠换成反斜杠', () => {
    expect(normalizePath('D:/Pics/Sub/A.JPG')).toBe('d:\\Pics\\Sub\\A.JPG')
  })

  it('UNC 路径保持原样，不硬塞盘符规则', () => {
    expect(normalizePath('\\\\NAS\\share\\a.mp4')).toBe('\\\\NAS\\share\\a.mp4')
  })
})

describe('文件名清洗', () => {
  it('非法字符替换为空格，不把前后文字粘在一起', () => {
    expect(sanitizeBaseName('a<b>c:d"e/f\\g|h?i*j')).toBe('a b c d e f g h i j')
  })

  it('去掉结尾的句点与空格', () => {
    expect(sanitizeBaseName('报告...  ')).toBe('报告')
    expect(sanitizeBaseName('...')).toBe('未命名')
  })

  it('Windows 保留设备名加下划线前缀', () => {
    expect(sanitizeBaseName('CON')).toBe('_CON')
    expect(sanitizeBaseName('con')).toBe('_con')
    expect(sanitizeBaseName('nul.txt')).toBe('_nul.txt')
    expect(sanitizeBaseName('COM1')).toBe('_COM1')
  })

  it('超长标题按码点截断到 120，不劈开字符', () => {
    const long = '栖'.repeat(300)
    expect(Array.from(sanitizeBaseName(long)).length).toBe(120)
    const emoji = '😀'.repeat(200)
    expect(Array.from(sanitizeBaseName(emoji)).length).toBe(120)
  })

  it('空标题回落到默认名', () => {
    expect(sanitizeBaseName('   ')).toBe('未命名')
  })
})

describe('扩展名提取', () => {
  it('从 URL 路径取扩展名，查询串不参与', () => {
    expect(extFromUrl('https://cdn.example.com/a/b.MP4?token=1&x=.exe')).toBe('mp4')
    expect(extFromUrl('https://cdn.example.com/a/b.jpeg')).toBe('jpeg')
  })

  it('没有扩展名或地址不合法时返回 null，由调用方决定回落值', () => {
    expect(extFromUrl('https://cdn.example.com/a/b')).toBeNull()
    expect(extFromUrl('not a url')).toBeNull()
  })
})

describe('目标路径去重', () => {
  it('同名文件已存在时依次追加 (1)、(2)', () => {
    const taken = new Set<string>(['d:\\pics\\cat.jpg', 'd:\\pics\\cat (1).jpg'])
    const path = buildTargetPath('D:/pics', 'cat', 'jpg', (candidate) => taken.has(candidate))
    expect(path).toBe('d:\\pics\\cat (2).jpg')
  })

  it('没有冲突时使用原始文件名', () => {
    expect(buildTargetPath('d:\\pics', 'cat', 'jpg', () => false)).toBe('d:\\pics\\cat.jpg')
  })

  it('超长目录下仍把完整路径压进 260 字符上限', () => {
    const dir = `c:\\${'a'.repeat(200)}`
    const path = buildTargetPath(dir, 'b'.repeat(120), 'jpg', () => false)
    expect(path.length).toBeLessThanOrEqual(259)
    expect(path.endsWith('.jpg')).toBe(true)
  })

  it('候选名全部被占用时报错，不无限循环', () => {
    expect(() => buildTargetPath('d:\\pics', 'cat', 'jpg', () => true)).toThrow()
  })
})
