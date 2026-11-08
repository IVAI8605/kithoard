import crypto from 'node:crypto'
import fs from 'node:fs'
import type { AssetType, DownloadState, LicenseState, RestoreSummary } from '@shared/types'
import { getDb } from '../db'
import { BACKUP_SCHEMA_VERSION, type BackupFile } from './format'

/**
 * settings 里可随备份迁移的键：只放「用户偏好」，不放秘密。
 * source.apiKey.* 永远不导出、也永远不接受导入，备份文件本身是不加密的明文 JSON。
 */
const EXPORTABLE_SETTINGS = ['source.enabled', 'download.dir', 'download.concurrency'] as const
const IMPORTABLE_SETTINGS = new Set<string>(EXPORTABLE_SETTINGS)

/** 只有这三种状态代表「任务已收尾」；其余状态在导入时统一降为 paused */
const TERMINAL_STATES: ReadonlySet<DownloadState> = new Set<DownloadState>([
  'completed',
  'failed',
  'canceled'
])

interface AssetRow {
  source_id: string
  remote_id: string
  type: AssetType
  title: string
  thumb_url: string | null
  preview_url: string | null
  page_url: string | null
  width: number | null
  height: number | null
  duration_sec: number | null
  size_bytes: number | null
  license: LicenseState
  tags: string | null
  fetched_at: number
}

interface FavoriteRow {
  created_at: number
  source_id: string
  remote_id: string
}

interface DownloadRow {
  id: string
  state: DownloadState
  target_path: string
  url: string
  total_bytes: number | null
  received_bytes: number
  etag: string | null
  last_modified: string | null
  retry_count: number
  error_code: string | null
  sort_order: number
  created_at: number
  updated_at: number
  source_id: string | null
  remote_id: string | null
}

interface LocalFileRow {
  path: string
  size_bytes: number | null
  created_at: number
  updated_at: number
  download_id: string | null
  source_id: string | null
  remote_id: string | null
}

function assetKey(sourceId: string, remoteId: string): string {
  // 用不可见分隔符拼 key，避免 sourceId 里恰好含分隔字符时两个不同素材撞到一起
  return `${sourceId}\u0000${remoteId}`
}

/** 导出：只读库，不碰磁盘上的素材文件（§5.7 第 2 条） */
export function buildBackup(input: { appVersion: string; now?: number }): BackupFile {
  const db = getDb()
  const now = input.now ?? Date.now()

  const assetRows = db
    .prepare(
      `SELECT source_id, remote_id, type, title, thumb_url, preview_url, page_url,
              width, height, duration_sec, size_bytes, license, tags, fetched_at
         FROM assets
        ORDER BY id`
    )
    .all() as AssetRow[]

  const favoriteRows = db
    .prepare(
      `SELECT f.created_at, a.source_id, a.remote_id
         FROM favorites f
         JOIN assets a ON a.id = f.asset_id
        ORDER BY f.created_at, f.id`
    )
    .all() as FavoriteRow[]

  const downloadRows = db
    .prepare(
      `SELECT d.id, d.state, d.target_path, d.url, d.total_bytes, d.received_bytes,
              d.etag, d.last_modified, d.retry_count, d.error_code, d.sort_order,
              d.created_at, d.updated_at, a.source_id, a.remote_id
         FROM downloads d
         LEFT JOIN assets a ON a.id = d.asset_id
        ORDER BY d.sort_order, d.created_at`
    )
    .all() as DownloadRow[]

  const localFileRows = db
    .prepare(
      `SELECT l.path, l.size_bytes, l.created_at, l.updated_at, l.download_id,
              a.source_id, a.remote_id
         FROM local_files l
         LEFT JOIN assets a ON a.id = l.asset_id
        ORDER BY l.id`
    )
    .all() as LocalFileRow[]

  const settingRows = db
    .prepare(
      `SELECT key, value FROM settings
        WHERE key IN (${EXPORTABLE_SETTINGS.map(() => '?').join(', ')})`
    )
    .all(...EXPORTABLE_SETTINGS) as Array<{ key: string; value: string }>

  const settings: Record<string, string> = {}
  for (const row of settingRows) settings[row.key] = row.value

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: input.appVersion,
    exportedAt: now,
    assets: assetRows.map((row) => ({
      sourceId: row.source_id,
      remoteId: row.remote_id,
      type: row.type,
      title: row.title,
      thumbUrl: row.thumb_url,
      previewUrl: row.preview_url,
      pageUrl: row.page_url,
      width: row.width,
      height: row.height,
      durationSec: row.duration_sec,
      sizeBytes: row.size_bytes,
      license: row.license,
      tags: parseTags(row.tags),
      fetchedAt: row.fetched_at
    })),
    favorites: favoriteRows.map((row) => ({
      sourceId: row.source_id,
      remoteId: row.remote_id,
      createdAt: row.created_at
    })),
    downloads: downloadRows.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      remoteId: row.remote_id,
      state: row.state,
      targetPath: row.target_path,
      url: row.url,
      totalBytes: row.total_bytes,
      receivedBytes: row.received_bytes,
      etag: row.etag,
      lastModified: row.last_modified,
      retryCount: row.retry_count,
      errorCode: row.error_code,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })),
    localFiles: localFileRows.map((row) => ({
      sourceId: row.source_id,
      remoteId: row.remote_id,
      downloadId: row.download_id,
      path: row.path,
      sizeBytes: row.size_bytes,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })),
    settings
  }
}

function parseTags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    // tags 只是展示用，单条坏数据不值得让整个导出失败
    return []
  }
}

/**
 * 导入算法（§5.7，顺序不可颠倒）：
 * assets upsert → 建 remote_id → 新 id 映射 → 重建收藏 → 下载/本地记录按路径去重。
 * 整个导入在一个事务里完成；任何一步抛错都会回滚，现有数据保持原样。
 */
export function restoreBackup(file: BackupFile): RestoreSummary {
  const db = getDb()
  const summary: RestoreSummary = {
    addedAssets: 0,
    addedFavorites: 0,
    addedDownloads: 0,
    addedLocalFiles: 0,
    existingDownloads: 0,
    existingLocalFiles: 0,
    missingPaths: 0
  }

  const findAsset = db.prepare('SELECT id FROM assets WHERE source_id = ? AND remote_id = ?')
  const upsertAsset = db.prepare(
    `INSERT INTO assets (
       source_id, remote_id, type, title, thumb_url, preview_url, page_url,
       width, height, duration_sec, size_bytes, license, tags, fetched_at
     ) VALUES (
       @sourceId, @remoteId, @type, @title, @thumbUrl, @previewUrl, @pageUrl,
       @width, @height, @durationSec, @sizeBytes, @license, @tags, @fetchedAt
     )
     ON CONFLICT(source_id, remote_id) DO UPDATE SET
       title = excluded.title,
       thumb_url = excluded.thumb_url,
       preview_url = excluded.preview_url,
       page_url = excluded.page_url,
       width = excluded.width,
       height = excluded.height,
       duration_sec = excluded.duration_sec,
       size_bytes = excluded.size_bytes,
       license = excluded.license,
       tags = excluded.tags,
       fetched_at = excluded.fetched_at
     RETURNING id`
  )

  const insertFavorite = db.prepare(
    'INSERT OR IGNORE INTO favorites (asset_id, created_at) VALUES (?, ?)'
  )

  const findDownloadByPath = db.prepare('SELECT id FROM downloads WHERE target_path = ?')
  const findDownloadById = db.prepare('SELECT 1 AS value FROM downloads WHERE id = ?')
  const insertDownload = db.prepare(
    `INSERT INTO downloads (
       id, asset_id, state, target_path, url, total_bytes, received_bytes,
       etag, last_modified, retry_count, error_code, sort_order, created_at, updated_at
     ) VALUES (
       @id, @assetId, @state, @targetPath, @url, @totalBytes, @receivedBytes,
       @etag, @lastModified, @retryCount, @errorCode, @sortOrder, @createdAt, @updatedAt
     )`
  )

  const findLocalByPath = db.prepare('SELECT 1 AS value FROM local_files WHERE path = ?')
  const insertLocalFile = db.prepare(
    `INSERT INTO local_files (
       asset_id, download_id, path, status, size_bytes, created_at, updated_at
     ) VALUES (
       @assetId, @downloadId, @path, @status, @sizeBytes, @createdAt, @updatedAt
     )`
  )

  const writeSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )

  const write = db.transaction(() => {
    // 1. 素材：一律以 (source_id, remote_id) 解析，绝不使用备份里的本地自增 id
    const assetIds = new Map<string, number>()
    for (const asset of file.assets) {
      const existing = findAsset.get(asset.sourceId, asset.remoteId) as { id: number } | undefined
      const row = upsertAsset.get({
        sourceId: asset.sourceId,
        remoteId: asset.remoteId,
        type: asset.type,
        title: asset.title,
        thumbUrl: asset.thumbUrl,
        previewUrl: asset.previewUrl,
        pageUrl: asset.pageUrl,
        width: asset.width,
        height: asset.height,
        durationSec: asset.durationSec,
        sizeBytes: asset.sizeBytes,
        license: asset.license,
        tags: JSON.stringify(asset.tags),
        fetchedAt: asset.fetchedAt
      }) as { id: number }
      if (!existing) summary.addedAssets += 1
      assetIds.set(assetKey(asset.sourceId, asset.remoteId), row.id)
    }

    // 2. 收藏：按映射重建；备份里引用了 assets 之外的素材时，最后尝试按远程标识找本机已有记录
    for (const favorite of file.favorites) {
      const key = assetKey(favorite.sourceId, favorite.remoteId)
      let assetId = assetIds.get(key)
      if (assetId === undefined) {
        const existing = findAsset.get(favorite.sourceId, favorite.remoteId) as
          | { id: number }
          | undefined
        assetId = existing?.id
      }
      if (assetId === undefined) continue
      if (insertFavorite.run(assetId, favorite.createdAt).changes > 0) summary.addedFavorites += 1
    }

    // 3. 下载历史：按目标路径去重；id 冲突时重新生成，绝不覆盖本机任务
    const downloadIds = new Map<string, string>()
    for (const task of file.downloads) {
      const existing = findDownloadByPath.get(task.targetPath) as { id: string } | undefined
      if (existing) {
        downloadIds.set(task.id, existing.id)
        summary.existingDownloads += 1
        continue
      }
      const id = findDownloadById.get(task.id) ? crypto.randomUUID() : task.id
      // 旧机器上没下完的任务导入后一律暂停：用户没在新机器上点过「继续」，不能自动开跑
      const state = TERMINAL_STATES.has(task.state) ? task.state : 'paused'
      const assetId =
        task.sourceId !== null && task.remoteId !== null
          ? (assetIds.get(assetKey(task.sourceId, task.remoteId)) ?? null)
          : null
      insertDownload.run({
        id,
        assetId,
        state,
        targetPath: task.targetPath,
        url: task.url,
        totalBytes: task.totalBytes,
        receivedBytes: task.receivedBytes,
        etag: task.etag,
        lastModified: task.lastModified,
        retryCount: task.retryCount,
        errorCode: task.errorCode,
        sortOrder: task.sortOrder,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt
      })
      downloadIds.set(task.id, id)
      summary.addedDownloads += 1
    }

    // 4. 本地文件：状态以本机磁盘为准；文件不在就标 missing，不阻断导入
    for (const item of file.localFiles) {
      if (findLocalByPath.get(item.path)) {
        summary.existingLocalFiles += 1
        continue
      }
      const exists = safeExists(item.path)
      if (!exists) summary.missingPaths += 1
      const assetId =
        item.sourceId !== null && item.remoteId !== null
          ? (assetIds.get(assetKey(item.sourceId, item.remoteId)) ?? null)
          : null
      const downloadId = item.downloadId ? (downloadIds.get(item.downloadId) ?? null) : null
      insertLocalFile.run({
        assetId,
        downloadId,
        path: item.path,
        status: exists ? 'present' : 'missing',
        sizeBytes: item.sizeBytes,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      })
      summary.addedLocalFiles += 1
    }

    // 5. 设置：只写白名单键；source.apiKey.* 即便出现在文件里也直接忽略
    applySettings(file, (key, value) => {
      writeSetting.run(key, value)
    })
  })

  write()
  return summary
}

function applySettings(file: BackupFile, write: (key: string, value: string) => void): void {
  for (const [key, value] of Object.entries(file.settings)) {
    if (!IMPORTABLE_SETTINGS.has(key)) continue

    if (key === 'source.enabled') {
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        continue
      }
      if (!Array.isArray(parsed) || parsed.length === 0) continue
      if (!parsed.every((id): id is string => typeof id === 'string' && id.length > 0)) continue
    }

    if (key === 'download.concurrency') {
      const number = Number(value)
      if (!Number.isInteger(number) || number < 1 || number > 5) continue
    }

    if (key === 'download.dir' && !value.trim()) continue

    write(key, value)
  }
}

function safeExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath)
  } catch {
    return false
  }
}
