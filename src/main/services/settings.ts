import os from 'node:os'
import path from 'node:path'
import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron'
import { READABLE_SETTINGS, WRITABLE_SETTINGS } from '@shared/channels'
import { makeError } from '@shared/errors'
import { cacheSize, cleanCache, type CacheCleanResult } from '../cache/clean'
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
  const value = Number(getPlainSetting('download.concurrency'))
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
      if (key === 'source.apiKey.pixabay') return hasApiKey('pixabay')
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

      if (key === 'source.apiKey.pixabay') {
        if (typeof value !== 'string' || value.length > 200) {
          throw makeError('E_INVALID_ARG', 'value')
        }
        setApiKey('pixabay', value)
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
    }
  }
}
