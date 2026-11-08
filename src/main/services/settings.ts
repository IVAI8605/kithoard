import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow, dialog, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import { READABLE_SETTINGS, WRITABLE_SETTINGS } from '@shared/channels'
import { makeError } from '@shared/errors'
import type { BackupImportResult, BackupExportResult } from '@shared/types'
import { buildBackup, restoreBackup } from '../backup'
import { parseBackupJson } from '../backup/format'
import { cacheSize, cleanCache, type CacheCleanResult } from '../cache/clean'
import { log } from '../log'
import { assertMovableDir } from '../library/fs-ops'
import {
  getEnabledSources,
  getPlainSetting,
  hasApiKey,
  isKeyStorageEncrypted,
  setApiKey,
  setEnabledSources,
  setPlainSetting
} from '../settings'
import type { SourceRegistry } from '../sources/registry'

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
}

function readKey(raw: unknown, allowed: readonly string[]): string {
  const key = asRecord(raw).key
  if (typeof key !== 'string' || !allowed.includes(key)) throw makeError('E_INVALID_ARG', 'key')
  return key
}

function defaultDownloadDir(): string {
  return path.join(os.homedir(), 'Pictures', 'Kithoard')
}

function currentDownloadDir(): string {
  return getPlainSetting('download.dir')?.trim() || defaultDownloadDir()
}

function currentConcurrency(): number {
  const raw = getPlainSetting('download.concurrency')
  // Number(null) 是 0，直接转数字会把「没设置过」误判成并发 1；必须先挡掉空值
  if (raw === null || raw.trim() === '') return 3
  const value = Number(raw)
  if (!Number.isFinite(value)) return 3
  return Math.min(5, Math.max(1, Math.trunc(value)))
}

export interface SettingsService {
  read(raw: unknown): unknown
  write(raw: unknown): { ok: true }
  /** 让用户选下载目录；取消返回 null */
  pickDir(): Promise<{ path: string | null }>
  /** 手动清理缓存；自动清理在启动时执行 */
  cleanCache(): CacheCleanResult
  /** 导出数据备份；用户取消时 path 为 null */
  exportBackup(): Promise<BackupExportResult>
  /** 导入数据备份；用户取消时 summary 为 null */
  importBackup(): Promise<BackupImportResult>
}

/**
 * 设置读写走白名单而不是全表放开：秘密项只能"问有没有"，不能"取出来"，
 * 这样界面与未来的 agent 网关都不会把 Key 带出主进程。
 */
export function createSettingsService(deps: {
  registry: SourceRegistry
  cacheRoot: string
  /** 并发数变更后立刻重新取任务；调小不打断在跑任务，调大马上补位 */
  pump: () => void
}): SettingsService {
  return {
    read(raw) {
      const key = readKey(raw, READABLE_SETTINGS)
      if (key === 'source.enabled') return getEnabledSources()
      if (key.startsWith('source.apiKey.')) {
        return hasApiKey(key.slice('source.apiKey.'.length))
      }
      if (key === 'download.dir') return currentDownloadDir()
      if (key === 'download.concurrency') return currentConcurrency()
      if (key === 'cache.size') return cacheSize(deps.cacheRoot)
      // app.keyStorage：让设置面板能如实提示「明文降级」，而不是假装已加密
      return isKeyStorageEncrypted() ? 'encrypted' : 'plaintext'
    },

    write(raw) {
      const record = asRecord(raw)
      const key = readKey(record, WRITABLE_SETTINGS)
      const value = record.value

      if (key.startsWith('source.apiKey.')) {
        if (typeof value !== 'string' || value.length > 200) {
          throw makeError('E_INVALID_ARG', 'value')
        }
        setApiKey(key.slice('source.apiKey.'.length), value)
        return { ok: true }
      }

      if (key === 'download.dir') {
        // 与「移动素材」共用同一套目录白名单：系统目录、盘符根一律不允许
        const dir = assertMovableDir(value)
        setPlainSetting('download.dir', dir)
        return { ok: true }
      }

      if (key === 'download.concurrency') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) {
          throw makeError('E_INVALID_ARG', 'download.concurrency')
        }
        setPlainSetting('download.concurrency', String(value))
        deps.pump()
        return { ok: true }
      }

      const knownIds = new Set(deps.registry.all().map(({ adapter }) => adapter.id))
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        !value.every((id): id is string => typeof id === 'string' && knownIds.has(id))
      ) {
        throw makeError('E_INVALID_ARG', 'source.enabled')
      }
      setEnabledSources(value)
      return { ok: true }
    },

    async pickDir() {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options: OpenDialogOptions = {
        title: '选择素材保存目录',
        defaultPath: currentDownloadDir(),
        properties: ['openDirectory', 'createDirectory']
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return { path: result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0] }
    },

    cleanCache() {
      return cleanCache(deps.cacheRoot)
    },

    async exportBackup() {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options: SaveDialogOptions = {
        title: '导出数据备份',
        defaultPath: path.join(app.getPath('desktop'), `kithoard-backup-${dateStamp(new Date())}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) {
        return { path: null, bytes: 0, counts: emptyCounts() }
      }

      // 备份只读库、不打包素材文件；Key 在 buildBackup 的 settings 白名单里已被剔除
      const backup = buildBackup({ appVersion: app.getVersion() })
      const text = JSON.stringify(backup, null, 2)
      fs.writeFileSync(result.filePath, text, 'utf8')
      log.info(
        `backup exported assets=${backup.assets.length} favorites=${backup.favorites.length} downloads=${backup.downloads.length}`
      )
      return {
        path: result.filePath,
        bytes: Buffer.byteLength(text, 'utf8'),
        counts: {
          assets: backup.assets.length,
          favorites: backup.favorites.length,
          downloads: backup.downloads.length,
          localFiles: backup.localFiles.length
        }
      }
    },

    async importBackup() {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options: OpenDialogOptions = {
        title: '导入数据备份',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null, summary: null }
      }

      const filePath = result.filePaths[0]
      // 解析与校验都在写库之前完成；结构不合法时抛 E_RESTORE_INVALID，库不会被改动
      const backup = parseBackupJson(fs.readFileSync(filePath, 'utf8'))
      const summary = restoreBackup(backup)
      // 并发数可能随备份变化，导入后立刻让队列按新值取任务
      deps.pump()
      log.info(
        `backup imported assets=${summary.addedAssets} favorites=${summary.addedFavorites} downloads=${summary.addedDownloads} local=${summary.addedLocalFiles} missing=${summary.missingPaths}`
      )
      return { path: filePath, summary }
    }
  }
}

function emptyCounts(): BackupExportResult['counts'] {
  return { assets: 0, favorites: 0, downloads: 0, localFiles: 0 }
}

/** 备份文件名带本地时间，连续导出不会互相覆盖 */
function dateStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}
