import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildBackup, restoreBackup } from '../src/main/backup'
import { BACKUP_SCHEMA_VERSION, parseBackupJson, type BackupFile } from '../src/main/backup/format'
import { closeDatabase, openDatabase } from '../src/main/db/index'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithoard-backup-test-'))
let db: ReturnType<typeof openDatabase>

beforeAll(() => {
  db = openDatabase(dir)
})
afterAll(() => {
  closeDatabase()
})
beforeEach(() => {
  // 先删引用方再删被引用表，避免外键挡住清理
  db.prepare('DELETE FROM local_files').run()
  db.prepare('DELETE FROM downloads').run()
  db.prepare('DELETE FROM favorites').run()
  db.prepare('DELETE FROM assets').run()
  db.prepare('DELETE FROM settings').run()
})

function insertAsset(sourceId: string, remoteId: string, title: string): number {
  const row = db
    .prepare(
      `INSERT INTO assets (source_id, remote_id, type, title, license, fetched_at)
       VALUES (?, ?, 'image', ?, 'free', ?)
       RETURNING id`
    )
    .get(sourceId, remoteId, title, Date.now()) as { id: number }
  return row.id
}

function makeAsset(sourceId: string, remoteId: string, title: string): BackupFile['assets'][number] {
  return {
    sourceId,
    remoteId,
    type: 'image',
    title,
    thumbUrl: null,
    previewUrl: `https://example.test/${remoteId}.jpg`,
    pageUrl: null,
    width: 100,
    height: 100,
    durationSec: null,
    sizeBytes: 1024,
    license: 'free',
    tags: [],
    fetchedAt: 1
  }
}

function makeDownload(
  id: string,
  state: BackupFile['downloads'][number]['state'],
  targetPath: string
): BackupFile['downloads'][number] {
  return {
    id,
    sourceId: 'pixabay',
    remoteId: 'p1',
    state,
    targetPath,
    url: 'https://example.test/file.jpg',
    totalBytes: 1024,
    receivedBytes: 0,
    etag: null,
    lastModified: null,
    retryCount: 0,
    errorCode: null,
    sortOrder: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

function emptyBackup(overrides: Partial<BackupFile> = {}): BackupFile {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: '0.3.0',
    exportedAt: 1,
    assets: [],
    favorites: [],
    downloads: [],
    localFiles: [],
    settings: {},
    ...overrides
  }
}

describe('备份导出', () => {
  it('剔除 API Key，保留可迁移的偏好设置', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('source.apiKey.pixabay', 'plain:secret')").run()
    db.prepare("INSERT INTO settings (key, value) VALUES ('download.concurrency', '3')").run()
    db.prepare("INSERT INTO settings (key, value) VALUES ('download.dir', 'D:/media')").run()

    const backup = buildBackup({ appVersion: '0.3.0', now: 123 })

    expect(backup.schemaVersion).toBe(BACKUP_SCHEMA_VERSION)
    expect(backup.appVersion).toBe('0.3.0')
    expect(backup.exportedAt).toBe(123)
    expect(Object.keys(backup.settings)).not.toContain('source.apiKey.pixabay')
    expect(backup.settings['download.concurrency']).toBe('3')
    expect(backup.settings['download.dir']).toBe('D:/media')
    // 防止将来有人把 Key 拼进别的字段：整份 JSON 里都不该出现明文
    expect(JSON.stringify(backup)).not.toContain('secret')
  })

  it('素材、收藏、下载与本地记录按远程标识导出，不带本地自增 id', () => {
    const assetId = insertAsset('pixabay', 'p1', 'Cat')
    db.prepare('INSERT INTO favorites (asset_id, created_at) VALUES (?, ?)').run(assetId, 9)
    db.prepare(
      `INSERT INTO downloads (id, asset_id, state, target_path, url, created_at, updated_at)
       VALUES ('task-1', ?, 'completed', 'D:/media/cat.jpg', 'https://example.test/cat.jpg', 1, 2)`
    ).run(assetId)
    db.prepare(
      `INSERT INTO local_files (asset_id, download_id, path, status, size_bytes, created_at, updated_at)
       VALUES (?, 'task-1', 'D:/media/cat.jpg', 'present', 1024, 1, 2)`
    ).run(assetId)

    const backup = buildBackup({ appVersion: '0.3.0' })

    expect(backup.assets).toHaveLength(1)
    expect(backup.assets[0]).toMatchObject({ sourceId: 'pixabay', remoteId: 'p1', title: 'Cat' })
    expect(backup.favorites).toEqual([{ sourceId: 'pixabay', remoteId: 'p1', createdAt: 9 }])
    expect(backup.downloads[0]).toMatchObject({ id: 'task-1', sourceId: 'pixabay', remoteId: 'p1' })
    expect(backup.localFiles[0]).toMatchObject({ path: 'D:/media/cat.jpg', downloadId: 'task-1' })
  })
})

describe('备份导入', () => {
  it('按 (source_id, remote_id) 重建素材与收藏，不信任备份里的本地 id', () => {
    const summary = restoreBackup(
      emptyBackup({
        assets: [makeAsset('pixabay', 'p1', 'Cat'), makeAsset('pexels', 'x1', 'Dog')],
        favorites: [{ sourceId: 'pixabay', remoteId: 'p1', createdAt: 5 }]
      })
    )

    expect(summary.addedAssets).toBe(2)
    expect(summary.addedFavorites).toBe(1)
    const row = db
      .prepare(
        `SELECT a.source_id AS sourceId, a.remote_id AS remoteId
           FROM favorites f JOIN assets a ON a.id = f.asset_id`
      )
      .get()
    expect(row).toEqual({ sourceId: 'pixabay', remoteId: 'p1' })
  })

  it('本地文件按磁盘存在性标记 present / missing，不阻断导入', () => {
    const presentPath = path.join(dir, 'present.jpg')
    fs.writeFileSync(presentPath, 'x')
    const missingPath = path.join(dir, 'missing.jpg')

    const summary = restoreBackup(
      emptyBackup({
        assets: [makeAsset('pixabay', 'p1', 'Cat')],
        localFiles: [
          {
            sourceId: 'pixabay',
            remoteId: 'p1',
            downloadId: null,
            path: presentPath,
            sizeBytes: 1,
            createdAt: 1,
            updatedAt: 1
          },
          {
            sourceId: 'pixabay',
            remoteId: 'p1',
            downloadId: null,
            path: missingPath,
            sizeBytes: 1,
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )

    expect(summary.addedLocalFiles).toBe(2)
    expect(summary.missingPaths).toBe(1)
    const rows = db.prepare('SELECT path, status FROM local_files ORDER BY id').all()
    expect(rows).toEqual([
      { path: presentPath, status: 'present' },
      { path: missingPath, status: 'missing' }
    ])
  })

  it('未完成的下载导入后统一降为 paused，已完成保持原状态', () => {
    restoreBackup(
      emptyBackup({
        downloads: [
          makeDownload('d1', 'queued', 'D:/media/a.jpg'),
          makeDownload('d2', 'completed', 'D:/media/b.jpg')
        ]
      })
    )

    const rows = db.prepare('SELECT id, state FROM downloads ORDER BY target_path').all()
    expect(rows).toEqual([
      { id: 'd1', state: 'paused' },
      { id: 'd2', state: 'completed' }
    ])
  })

  it('备份任务 id 与本机冲突时重新生成，不覆盖本机任务', () => {
    db.prepare(
      `INSERT INTO downloads (id, state, target_path, url, created_at, updated_at)
       VALUES ('dup', 'completed', 'D:/local/old.jpg', 'https://example.test/old.jpg', 1, 1)`
    ).run()

    restoreBackup(emptyBackup({ downloads: [makeDownload('dup', 'queued', 'D:/media/new.jpg')] }))

    const rows = db.prepare('SELECT id, target_path FROM downloads ORDER BY target_path').all() as Array<{
      id: string
      target_path: string
    }>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ id: 'dup', target_path: 'D:/local/old.jpg' })
    expect(rows[1].id).not.toBe('dup')
  })

  it('重复导入同一份备份不重复插入', () => {
    const presentPath = path.join(dir, 'dup.jpg')
    fs.writeFileSync(presentPath, 'x')
    const file = emptyBackup({
      assets: [makeAsset('pixabay', 'p1', 'Cat')],
      favorites: [{ sourceId: 'pixabay', remoteId: 'p1', createdAt: 5 }],
      downloads: [makeDownload('d1', 'completed', presentPath)],
      localFiles: [
        {
          sourceId: 'pixabay',
          remoteId: 'p1',
          downloadId: 'd1',
          path: presentPath,
          sizeBytes: 1,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    restoreBackup(file)
    const second = restoreBackup(file)

    expect(second.addedAssets).toBe(0)
    expect(second.addedFavorites).toBe(0)
    expect(second.existingDownloads).toBe(1)
    expect(second.existingLocalFiles).toBe(1)
  })

  it('导入忽略备份里的 API Key，只接受偏好设置白名单', () => {
    restoreBackup(
      emptyBackup({
        settings: {
          'source.apiKey.pixabay': 'plain:leak',
          'download.concurrency': '2',
          'unknown.key': 'x'
        }
      })
    )

    expect(
      db.prepare("SELECT COUNT(*) AS value FROM settings WHERE key = 'source.apiKey.pixabay'").get()
    ).toEqual({ value: 0 })
    expect(db.prepare("SELECT value FROM settings WHERE key = 'download.concurrency'").get()).toEqual({
      value: '2'
    })
    expect(db.prepare("SELECT COUNT(*) AS value FROM settings WHERE key = 'unknown.key'").get()).toEqual({
      value: 0
    })
  })

  it('导入非法设置值时不写坏配置', () => {
    restoreBackup(
      emptyBackup({
        settings: {
          'download.concurrency': '99',
          'source.enabled': 'not-json',
          'download.dir': '   '
        }
      })
    )

    expect(db.prepare('SELECT COUNT(*) AS value FROM settings').get()).toEqual({ value: 0 })
  })
})

describe('备份文件校验', () => {
  it('非法 JSON、缺 schemaVersion、高版本一律拒绝', () => {
    expect(() => parseBackupJson('{broken')).toThrow()
    expect(() => parseBackupJson(JSON.stringify({ assets: [] }))).toThrow()
    expect(() =>
      parseBackupJson(
        JSON.stringify({
          schemaVersion: BACKUP_SCHEMA_VERSION + 1,
          assets: [],
          favorites: [],
          downloads: [],
          localFiles: [],
          settings: {}
        })
      )
    ).toThrow()
  })

  it('字段类型错误拒绝导入，现有数据不受影响', () => {
    insertAsset('pixabay', 'p1', 'Cat')
    const broken = JSON.stringify({
      schemaVersion: 1,
      appVersion: '0.3.0',
      exportedAt: 1,
      assets: [{ sourceId: 'pixabay', remoteId: 'p1', type: 'gif', title: 'bad', license: 'free' }],
      favorites: [],
      downloads: [],
      localFiles: [],
      settings: {}
    })

    expect(() => parseBackupJson(broken)).toThrow()
    expect(db.prepare('SELECT COUNT(*) AS value FROM assets').get()).toEqual({ value: 1 })
  })
})
