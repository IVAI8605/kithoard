import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DownloadEngine } from '../src/main/download/engine'
import { closeDatabase, openDatabase } from '../src/main/db/index'
import { createResetService } from '../src/main/services/reset'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithoard-reset-test-'))
let db: ReturnType<typeof openDatabase>

beforeAll(() => {
  db = openDatabase(dir)
})
afterAll(() => {
  closeDatabase()
})
beforeEach(() => {
  db.prepare('DELETE FROM local_files').run()
  db.prepare('DELETE FROM downloads').run()
  db.prepare('DELETE FROM favorites').run()
  db.prepare('DELETE FROM assets').run()
  db.prepare('DELETE FROM settings').run()
})

/** 造一条完整数据：素材 + 收藏 + 下载 + 本地文件 + 设置；素材文件真实落盘 */
function seed(): { assetId: number; filePath: string; partPath: string } {
  const assetId = (
    db
      .prepare(
        `INSERT INTO assets (source_id, remote_id, type, title, license, fetched_at)
         VALUES ('pixabay', 'p1', 'image', 'Cat', 'free', 1)
         RETURNING id`
      )
      .get() as { id: number }
  ).id
  db.prepare('INSERT INTO favorites (asset_id, created_at) VALUES (?, ?)').run(assetId, 1)
  db.prepare(
    `INSERT INTO downloads (id, asset_id, state, target_path, url, created_at, updated_at)
     VALUES ('task-1', ?, 'completed', ?, 'https://example.test/cat.jpg', 1, 1)`
  ).run(assetId, path.join(dir, 'cat.jpg'))
  db.prepare(
    `INSERT INTO local_files (asset_id, download_id, path, status, size_bytes, created_at, updated_at)
     VALUES (?, 'task-1', ?, 'present', 3, 1, 1)`
  ).run(assetId, path.join(dir, 'cat.jpg'))
  db.prepare("INSERT INTO settings (key, value) VALUES ('source.apiKey.pixabay', 'plain:secret')").run()
  db.prepare("INSERT INTO settings (key, value) VALUES ('download.concurrency', '3')").run()

  const filePath = path.join(dir, 'cat.jpg')
  fs.writeFileSync(filePath, 'cat')
  const partPath = `${filePath}.part`
  fs.writeFileSync(partPath, 'half')
  return { assetId, filePath, partPath }
}

function count(table: 'favorites' | 'downloads' | 'settings' | 'assets' | 'local_files'): number {
  return (db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: number }).value
}

/** 清空数据不依赖引擎的真实行为，这里只记录 stop 调用 */
function fakeEngine(stops: string[] = []): DownloadEngine {
  return {
    pump: () => undefined,
    stop: async (taskId: string) => {
      stops.push(taskId)
      return true
    },
    shutdown: () => undefined
  }
}

describe('清空数据 service', () => {
  it('仅清空收藏，素材与下载记录不受影响', async () => {
    const { filePath } = seed()
    const service = createResetService({ engine: fakeEngine() })

    const result = await service.clearData({ scope: 'favorites' })

    expect(result).toEqual({ favorites: 1, downloads: 0, settings: 0 })
    expect(count('favorites')).toBe(0)
    expect(count('assets')).toBe(1)
    expect(count('downloads')).toBe(1)
    expect(count('local_files')).toBe(1)
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it('清空下载历史：local_files 保留且 download_id 置空，素材文件还在', async () => {
    const { filePath } = seed()
    const service = createResetService({ engine: fakeEngine() })

    const result = await service.clearData({ scope: 'downloads' })

    expect(result).toEqual({ favorites: 0, downloads: 1, settings: 0 })
    expect(count('downloads')).toBe(0)
    expect(count('local_files')).toBe(1)
    const row = db.prepare('SELECT download_id, path FROM local_files').get() as {
      download_id: string | null
      path: string
    }
    expect(row.download_id).toBeNull()
    expect(row.path).toBe(filePath)
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it('清空个人设置包含已保存的 API Key', async () => {
    seed()
    const service = createResetService({ engine: fakeEngine() })

    const result = await service.clearData({ scope: 'settings' })

    expect(result).toEqual({ favorites: 0, downloads: 0, settings: 2 })
    expect(count('settings')).toBe(0)
    expect(count('favorites')).toBe(1)
    expect(count('downloads')).toBe(1)
  })

  it('清空全部：三类记录清零，本地素材记录与磁盘文件保留', async () => {
    const { filePath } = seed()
    const service = createResetService({ engine: fakeEngine() })

    const result = await service.clearData({ scope: 'all' })

    expect(result).toEqual({ favorites: 1, downloads: 1, settings: 2 })
    expect(count('favorites')).toBe(0)
    expect(count('downloads')).toBe(0)
    expect(count('settings')).toBe(0)
    expect(count('assets')).toBe(1)
    expect(count('local_files')).toBe(1)
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it('清空下载历史前先停止活动任务，并清理无主的 .part', async () => {
    seed()
    // 追加一条仍在下载的任务，模拟引擎手里有会话
    db.prepare(
      `INSERT INTO downloads (id, state, target_path, url, created_at, updated_at)
       VALUES ('active-1', 'downloading', ?, 'https://example.test/busy.jpg', 1, 1)`
    ).run(path.join(dir, 'busy.jpg'))
    const activePart = path.join(dir, 'busy.jpg.part')
    fs.writeFileSync(activePart, 'half')

    const stops: string[] = []
    const service = createResetService({ engine: fakeEngine(stops) })

    await service.clearData({ scope: 'downloads' })

    expect(stops).toEqual(['active-1'])
    expect(fs.existsSync(activePart)).toBe(false)
    expect(count('downloads')).toBe(0)
  })

  it('非法范围拒绝，不删任何数据', async () => {
    seed()
    const service = createResetService({ engine: fakeEngine() })

    for (const bad of [{ scope: 'unknown' }, { scope: 1 }, { scope: null }, {}, null]) {
      await expect(service.clearData(bad)).rejects.toThrow()
    }
    expect(count('favorites')).toBe(1)
    expect(count('downloads')).toBe(1)
    expect(count('settings')).toBe(2)
  })
})
