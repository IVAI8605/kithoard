import { clipboard, ipcMain, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { CHANNELS, READABLE_SETTINGS, WRITABLE_SETTINGS } from '@shared/channels'
import { fail, isAppError, makeError, ok, type Envelope } from '@shared/errors'
import type { SourceInfo } from '@shared/types'
import { log } from '../log'
import {
  getApiKey,
  getEnabledSources,
  hasApiKey,
  isKeyStorageEncrypted,
  setApiKey,
  setEnabledSources
} from '../settings'
import { createSourceRegistry } from '../sources'
import type { SourceRegistry } from '../sources/registry'
import { createDetailHandler } from './detail'
import { createSearchHandler } from './search'

type Handler = (arg: unknown) => Promise<unknown> | unknown

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
}

function readKey(raw: unknown, allowed: readonly string[]): string {
  const key = asRecord(raw).key
  if (typeof key !== 'string' || !allowed.includes(key)) throw makeError('E_INVALID_ARG', 'key')
  return key
}

export function registerIpc(deps: { userDataDir: string }): void {
  const cacheRoot = path.join(deps.userDataDir, 'cache')
  const thumbsDir = path.join(cacheRoot, 'thumbs')
  const registry: SourceRegistry = createSourceRegistry({
    getApiKey,
    cacheDir: path.join(cacheRoot, 'http')
  })

  const listSources = (): SourceInfo[] => {
    const enabled = getEnabledSources()
    return registry.all().map(({ adapter, bucket }) => ({
      id: adapter.id,
      name: adapter.name,
      enabled: enabled.includes(adapter.id),
      ready: adapter.isReady(),
      requiresApiKey: adapter.capabilities.requiresApiKey,
      hasApiKey: adapter.capabilities.requiresApiKey ? hasApiKey(adapter.id) : true,
      rateLimitRemaining: bucket.remaining
    }))
  }

  const readSetting = (raw: unknown): unknown => {
    const key = readKey(raw, READABLE_SETTINGS)
    if (key === 'source.enabled') return getEnabledSources()
    if (key === 'source.apiKey.pixabay') return hasApiKey('pixabay')
    // app.keyStorage：让设置面板能如实提示「明文降级」，而不是假装已加密
    return isKeyStorageEncrypted() ? 'encrypted' : 'plaintext'
  }

  const writeSetting = (raw: unknown): { ok: true } => {
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

    const knownIds = new Set(registry.all().map(({ adapter }) => adapter.id))
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      !value.every((id): id is string => typeof id === 'string' && knownIds.has(id))
    ) {
      throw makeError('E_INVALID_ARG', 'source.enabled')
    }
    setEnabledSources(value)
    return { ok: true }
  }

  const copyText = (raw: unknown): { ok: true } => {
    const text = asRecord(raw).text
    if (typeof text !== 'string' || text.length === 0 || text.length > 2000) {
      throw makeError('E_INVALID_ARG', 'text')
    }
    if (!/^https?:\/\//i.test(text)) throw makeError('E_URL_FORBIDDEN')
    clipboard.writeText(text)
    return { ok: true }
  }

  const wrap =
    (handler: Handler) =>
    async (_event: IpcMainInvokeEvent, arg: unknown): Promise<Envelope<unknown>> => {
      try {
        return ok(await handler(arg))
      } catch (error) {
        if (isAppError(error)) return { ok: false, error }
        const detail = error instanceof Error ? error.message : String(error)
        log.error(`ipc error: ${detail}`)
        return fail('E_UNKNOWN', detail)
      }
    }

  ipcMain.handle(CHANNELS.sourceList, wrap(() => listSources()))
  ipcMain.handle(CHANNELS.searchRun, wrap(createSearchHandler({ registry, thumbsDir })))
  ipcMain.handle(CHANNELS.assetDetail, wrap(createDetailHandler({ registry, thumbsDir })))
  ipcMain.handle(CHANNELS.settingsGet, wrap(readSetting))
  ipcMain.handle(CHANNELS.settingsSet, wrap(writeSetting))
  ipcMain.handle(CHANNELS.copyText, wrap(copyText))
}
