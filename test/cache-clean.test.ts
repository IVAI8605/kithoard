import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cacheSize, cleanCache } from '../src/main/cache/clean'

function makeCache(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kithoard-cache-test-'))
  fs.mkdirSync(path.join(root, 'thumbs'), { recursive: true })
  fs.mkdirSync(path.join(root, 'http'), { recursive: true })
  return root
}

function writeFile(file: string, content: string, ageMs: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  if (ageMs > 0) {
    const time = new Date(Date.now() - ageMs)
    fs.utimesSync(file, time, time)
  }
}

describe('缓存清理', () => {
  it('只删超过 7 天的缩略图与响应缓存，保留新文件', () => {
    const root = makeCache()
    writeFile(path.join(root, 'thumbs', 'old.jpg'), 'aaaa', 8 * 24 * 3600 * 1000)
    writeFile(path.join(root, 'thumbs', 'new.jpg'), 'bbbb', 0)
    writeFile(path.join(root, 'http', 'old.json'), 'cc', 8 * 24 * 3600 * 1000)

    const result = cleanCache(root)
    expect(result.removed).toBe(2)
    expect(result.bytes).toBe(6)
    expect(fs.existsSync(path.join(root, 'thumbs', 'old.jpg'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'thumbs', 'new.jpg'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'http', 'old.json'))).toBe(false)
  })

  it('任何 .part 都不参与清理', () => {
    const root = makeCache()
    writeFile(path.join(root, 'http', 'old.jpg.part'), 'part', 30 * 24 * 3600 * 1000)
    const result = cleanCache(root)
    expect(result.removed).toBe(0)
    expect(fs.existsSync(path.join(root, 'http', 'old.jpg.part'))).toBe(true)
  })

  it('未知子目录不动', () => {
    const root = makeCache()
    writeFile(path.join(root, 'other', 'old.txt'), 'x', 30 * 24 * 3600 * 1000)
    const result = cleanCache(root)
    expect(result.removed).toBe(0)
    expect(fs.existsSync(path.join(root, 'other', 'old.txt'))).toBe(true)
  })

  it('占用统计与清理范围一致', () => {
    const root = makeCache()
    writeFile(path.join(root, 'thumbs', 'a.jpg'), '12345', 0)
    writeFile(path.join(root, 'http', 'b.json'), '123', 0)
    writeFile(path.join(root, 'other', 'c.txt'), 'ignored', 0)
    expect(cacheSize(root)).toBe(8)
  })

  it('缓存目录不存在时安全返回 0', () => {
    const root = path.join(os.tmpdir(), 'kithoard-cache-missing-9f3a')
    expect(cleanCache(root)).toEqual({ removed: 0, bytes: 0 })
    expect(cacheSize(root)).toBe(0)
  })
})
