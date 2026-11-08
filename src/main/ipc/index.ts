import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { CHANNELS } from '@shared/channels'
import { fail, isAppError, ok, type Envelope } from '@shared/errors'
import { log } from '../log'
import { getApiKey } from '../settings'
import { createSourceRegistry } from '../sources'
import type { SourceRegistry } from '../sources/registry'
import { createClipboardService } from '../services/clipboard'
import { createDetailService } from '../services/detail'
import { createDownloadService } from '../services/download'
import { createRecentService } from '../services/recent'
import { createSearchService } from '../services/search'
import { createSettingsService } from '../services/settings'
import { createSourceService } from '../services/sources'

type Handler = (arg: unknown) => Promise<unknown> | unknown

function wrap(
  handler: Handler
): (event: IpcMainInvokeEvent, arg: unknown) => Promise<Envelope<unknown>> {
  return async (_event, arg) => {
    try {
      return ok(await handler(arg))
    } catch (error) {
      if (isAppError(error)) return { ok: false, error }
      const detail = error instanceof Error ? error.message : String(error)
      log.error(`ipc error: ${detail}`)
      return fail('E_UNKNOWN', detail)
    }
  }
}

/**
 * IPC 层只做「通道 → service → 信封」的转接。业务与校验都在 services 里，
 * 这样 V1.1 的 agent 网关可以复用同一份实现，不会出现两套规则。
 */
export function registerIpc(deps: { userDataDir: string }): void {
  const cacheRoot = path.join(deps.userDataDir, 'cache')
  const registry: SourceRegistry = createSourceRegistry({
    getApiKey,
    cacheDir: path.join(cacheRoot, 'http')
  })

  const sources = createSourceService({ registry })
  const search = createSearchService({ registry, thumbsDir: path.join(cacheRoot, 'thumbs') })
  const detail = createDetailService({ registry, thumbsDir: path.join(cacheRoot, 'thumbs') })
  const recent = createRecentService({ registry, thumbsDir: path.join(cacheRoot, 'thumbs') })
  const settings = createSettingsService({ registry })
  const clipboard = createClipboardService()
  const download = createDownloadService()

  ipcMain.handle(
    CHANNELS.sourceList,
    wrap(() => sources.list())
  )
  ipcMain.handle(
    CHANNELS.searchRun,
    wrap((arg) => search.search(arg))
  )
  ipcMain.handle(
    CHANNELS.assetDetail,
    wrap((arg) => detail.get(arg))
  )
  ipcMain.handle(
    CHANNELS.assetRecent,
    wrap((arg) => recent.list(arg))
  )
  ipcMain.handle(
    CHANNELS.settingsGet,
    wrap((arg) => settings.read(arg))
  )
  ipcMain.handle(
    CHANNELS.settingsSet,
    wrap((arg) => settings.write(arg))
  )
  ipcMain.handle(
    CHANNELS.copyText,
    wrap((arg) => clipboard.writeExternalLink(arg))
  )
  ipcMain.handle(
    CHANNELS.downloadEnqueue,
    wrap((arg) => download.enqueue(arg))
  )
  ipcMain.handle(
    CHANNELS.downloadPause,
    wrap((arg) => download.pause(arg))
  )
  ipcMain.handle(
    CHANNELS.downloadCancel,
    wrap((arg) => download.cancel(arg))
  )
}
