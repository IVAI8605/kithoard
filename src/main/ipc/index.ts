import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { CHANNELS } from '@shared/channels'
import { fail, isAppError, ok, type Envelope } from '@shared/errors'
import { createDownloadEngine } from '../download/engine'
import { log } from '../log'
import { getApiKey } from '../settings'
import { createSourceRegistry } from '../sources'
import type { SourceRegistry } from '../sources/registry'
import { createClipboardService } from '../services/clipboard'
import { createDetailService } from '../services/detail'
import { createDownloadService } from '../services/download'
import { createQuarantineService } from '../services/quarantine'
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
 * 返回 shutdown 供退出流程先停下载再关库，避免异步写入撞上已关闭的连接。
 */
export function registerIpc(deps: { userDataDir: string }): { shutdown: () => void } {
  const cacheRoot = path.join(deps.userDataDir, 'cache')
  const registry: SourceRegistry = createSourceRegistry({
    getApiKey,
    cacheDir: path.join(cacheRoot, 'http')
  })

  // 下载进度/状态事件统一从这里广播；窗口还没建好时自然没人接收，不需要判空窗
  const emit = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
  }

  const sources = createSourceService({ registry })
  const search = createSearchService({ registry, thumbsDir: path.join(cacheRoot, 'thumbs') })
  const detail = createDetailService({ registry, thumbsDir: path.join(cacheRoot, 'thumbs') })
  const recent = createRecentService({ registry, thumbsDir: path.join(cacheRoot, 'thumbs') })
  const settings = createSettingsService({ registry })
  const clipboard = createClipboardService()
  const engine = createDownloadEngine({
    emit,
    quarantineDir: path.join(deps.userDataDir, 'quarantine')
  })
  const download = createDownloadService({ engine, notify: emit })
  const quarantine = createQuarantineService({ notify: emit })

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
  ipcMain.handle(
    CHANNELS.downloadResume,
    wrap((arg) => download.resume(arg))
  )
  ipcMain.handle(
    CHANNELS.downloadRetry,
    wrap((arg) => download.retry(arg))
  )
  ipcMain.handle(
    CHANNELS.downloadReorder,
    wrap((arg) => download.reorder(arg))
  )
  ipcMain.handle(
    CHANNELS.downloadList,
    wrap(() => download.list())
  )
  ipcMain.handle(
    CHANNELS.quarantineList,
    wrap(() => quarantine.list())
  )
  ipcMain.handle(
    CHANNELS.quarantineRestore,
    wrap((arg) => quarantine.restore(arg))
  )
  ipcMain.handle(
    CHANNELS.quarantineDiscard,
    wrap((arg) => quarantine.discard(arg))
  )

  return { shutdown: () => engine.shutdown() }
}
