import { makeError } from '@shared/errors'
import type { AssetType, DownloadState, LicenseState } from '@shared/types'

/**
 * 备份文件结构（§5.7）。schemaVersion 只在「结构」变化时升，
 * 应用版本变化不升，避免导入端把普通版本差异当成不兼容。
 */
export const BACKUP_SCHEMA_VERSION = 1

export interface BackupAsset {
  sourceId: string
  remoteId: string
  type: AssetType
  title: string
  thumbUrl: string | null
  previewUrl: string | null
  pageUrl: string | null
  width: number | null
  height: number | null
  durationSec: number | null
  sizeBytes: number | null
  license: LicenseState
  tags: string[]
  fetchedAt: number
}

/** 收藏只记「哪条远程素材」，绝不带本地自增 id：换机后 id 必然对不上 */
export interface BackupFavorite {
  sourceId: string
  remoteId: string
  createdAt: number
}

export interface BackupDownload {
  /** 备份内的任务 id，仅用于 localFiles 关联；导入时若与现有库冲突会重新生成 */
  id: string
  sourceId: string | null
  remoteId: string | null
  state: DownloadState
  targetPath: string
  url: string
  totalBytes: number | null
  receivedBytes: number
  etag: string | null
  lastModified: string | null
  retryCount: number
  errorCode: string | null
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface BackupLocalFile {
  sourceId: string | null
  remoteId: string | null
  downloadId: string | null
  path: string
  sizeBytes: number | null
  createdAt: number
  updatedAt: number
}

export interface BackupFile {
  schemaVersion: number
  appVersion: string
  exportedAt: number
  assets: BackupAsset[]
  favorites: BackupFavorite[]
  downloads: BackupDownload[]
  localFiles: BackupLocalFile[]
  /** 原始 settings 行；导出时已剔除 source.apiKey.* */
  settings: Record<string, string>
}

const ASSET_TYPES: readonly AssetType[] = ['image', 'video', 'audio', 'font', 'template']
const LICENSES: readonly LicenseState[] = ['free', 'paid', 'unknown']
const DOWNLOAD_STATES: readonly DownloadState[] = [
  'queued',
  'downloading',
  'paused',
  'verifying',
  'completed',
  'failed',
  'canceled',
  'quarantined'
]

function invalid(field: string): never {
  throw makeError('E_RESTORE_INVALID', field)
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
}

function readString(value: unknown, field: string, fallback?: string): string {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    return invalid(field)
  }
  if (typeof value !== 'string') return invalid(field)
  return value
}

function readNullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return invalid(field)
  return value
}

function readNumber(value: unknown, field: string, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    return invalid(field)
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalid(field)
  return value
}

function readNullableNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalid(field)
  return value
}

function readArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) return invalid(field)
  return value
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return invalid(field)
  return value as T
}

function readAsset(raw: unknown, index: number): BackupAsset {
  const record = asRecord(raw)
  const tags = record.tags === undefined || record.tags === null ? [] : readArray(record.tags, `assets[${index}].tags`)
  if (!tags.every((tag) => typeof tag === 'string')) invalid(`assets[${index}].tags`)
  return {
    sourceId: readString(record.sourceId, `assets[${index}].sourceId`),
    remoteId: readString(record.remoteId, `assets[${index}].remoteId`),
    type: readEnum(record.type, ASSET_TYPES, `assets[${index}].type`),
    title: readString(record.title, `assets[${index}].title`),
    thumbUrl: readNullableString(record.thumbUrl, `assets[${index}].thumbUrl`),
    previewUrl: readNullableString(record.previewUrl, `assets[${index}].previewUrl`),
    pageUrl: readNullableString(record.pageUrl, `assets[${index}].pageUrl`),
    width: readNullableNumber(record.width, `assets[${index}].width`),
    height: readNullableNumber(record.height, `assets[${index}].height`),
    durationSec: readNullableNumber(record.durationSec, `assets[${index}].durationSec`),
    sizeBytes: readNullableNumber(record.sizeBytes, `assets[${index}].sizeBytes`),
    license: readEnum(record.license, LICENSES, `assets[${index}].license`),
    tags: tags as string[],
    fetchedAt: readNumber(record.fetchedAt, `assets[${index}].fetchedAt`, 0)
  }
}

function readFavorite(raw: unknown, index: number): BackupFavorite {
  const record = asRecord(raw)
  return {
    sourceId: readString(record.sourceId, `favorites[${index}].sourceId`),
    remoteId: readString(record.remoteId, `favorites[${index}].remoteId`),
    createdAt: readNumber(record.createdAt, `favorites[${index}].createdAt`, 0)
  }
}

function readDownload(raw: unknown, index: number): BackupDownload {
  const record = asRecord(raw)
  return {
    id: readString(record.id, `downloads[${index}].id`),
    sourceId: readNullableString(record.sourceId, `downloads[${index}].sourceId`),
    remoteId: readNullableString(record.remoteId, `downloads[${index}].remoteId`),
    state: readEnum(record.state, DOWNLOAD_STATES, `downloads[${index}].state`),
    targetPath: readString(record.targetPath, `downloads[${index}].targetPath`),
    url: readString(record.url, `downloads[${index}].url`),
    totalBytes: readNullableNumber(record.totalBytes, `downloads[${index}].totalBytes`),
    receivedBytes: readNumber(record.receivedBytes, `downloads[${index}].receivedBytes`, 0),
    etag: readNullableString(record.etag, `downloads[${index}].etag`),
    lastModified: readNullableString(record.lastModified, `downloads[${index}].lastModified`),
    retryCount: readNumber(record.retryCount, `downloads[${index}].retryCount`, 0),
    errorCode: readNullableString(record.errorCode, `downloads[${index}].errorCode`),
    sortOrder: readNumber(record.sortOrder, `downloads[${index}].sortOrder`, 0),
    createdAt: readNumber(record.createdAt, `downloads[${index}].createdAt`, 0),
    updatedAt: readNumber(record.updatedAt, `downloads[${index}].updatedAt`, 0)
  }
}

function readLocalFile(raw: unknown, index: number): BackupLocalFile {
  const record = asRecord(raw)
  return {
    sourceId: readNullableString(record.sourceId, `localFiles[${index}].sourceId`),
    remoteId: readNullableString(record.remoteId, `localFiles[${index}].remoteId`),
    downloadId: readNullableString(record.downloadId, `localFiles[${index}].downloadId`),
    path: readString(record.path, `localFiles[${index}].path`),
    sizeBytes: readNullableNumber(record.sizeBytes, `localFiles[${index}].sizeBytes`),
    createdAt: readNumber(record.createdAt, `localFiles[${index}].createdAt`, 0),
    updatedAt: readNumber(record.updatedAt, `localFiles[${index}].updatedAt`, 0)
  }
}

function readSettings(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {}
  const record = asRecord(raw)
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') invalid(`settings.${key}`)
    result[key] = value
  }
  return result
}

/**
 * 导入前的入口校验：结构不合法一律 E_RESTORE_INVALID，且发生在任何写库动作之前。
 * 高于当前 schemaVersion 直接拒绝——本版读不懂新结构，硬导入只会写出半套数据。
 */
export function parseBackup(raw: unknown): BackupFile {
  const record = asRecord(raw)
  const schemaVersion = record.schemaVersion
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    return invalid('schemaVersion')
  }
  if (schemaVersion > BACKUP_SCHEMA_VERSION) {
    return invalid(`schemaVersion ${schemaVersion} > ${BACKUP_SCHEMA_VERSION}`)
  }

  return {
    schemaVersion,
    appVersion: readString(record.appVersion, 'appVersion', ''),
    exportedAt: readNumber(record.exportedAt, 'exportedAt', 0),
    assets: readArray(record.assets, 'assets').map(readAsset),
    favorites: readArray(record.favorites, 'favorites').map(readFavorite),
    downloads: readArray(record.downloads, 'downloads').map(readDownload),
    localFiles: readArray(record.localFiles, 'localFiles').map(readLocalFile),
    settings: readSettings(record.settings)
  }
}

/** 从 JSON 文本解析备份；语法错误是用户最常见的手工改坏场景，单独给出可读错误 */
export function parseBackupJson(text: string): BackupFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return invalid('invalid json')
  }
  return parseBackup(raw)
}
