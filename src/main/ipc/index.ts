import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { CHANNELS } from '@shared/channels'
import { fail, isAppError, ok, type Envelope } from '@shared/errors'
import { cleanCache } from '../cache/clean'
import { createDownloadEngine } from '../download/engine'
import { log } from '../log'
import { getApiKey } from '../settings'
import { createSourceRegistry } from '../sources'
import type { SourceRegistry } from '../sources/registry'
import { createClipboardService } from '../services/clipboard'
import { createDetailService } from '../services/detail'
import { createDownloadService } from '../services/download'
import { createFavoriteService } from '../services/favorite'
import { createLibraryService } from '../services/library'
import { createQuarantineService } from '../services/quarantine'
import { runStartupRecovery } from '../services/recovery'
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
  const clipboard = createClipboardService()
  const engine = createDownloadEngine({
    emit,
    quarantineDir: path.join(deps.userDataDir, 'quarantine')
  })
  // 设置里的并发数要立刻作用到队列，所以 settings 必须在 engine 之后创建
  const settings = createSettingsService({
    registry,
    cacheRoot,
    pump: () => engine.pump()
  })
  const download = createDownloadService({ engine, notify: emit })
  const quarantine = createQuarantineService({ notify: emit })
  const library = createLibraryService()
  const favorite = createFavoriteService()

  // §7.5-8：启动时清一次超过 7 天的缩略图与响应缓存；只动 cache，不碰下载临时文件
  const cleaned = cleanCache(cacheRoot)
  if (cleaned.removed > 0) {
    log.info(`cache clean removed=${cleaned.removed} bytes=${cleaned.bytes}`)
  }

  // 启动即对齐磁盘（§5.4）：窗口还没建，事件无人接收也没关系，界面随后 list() 拿到的就是校正后的状态
  const recovery = runStartupRecovery()

  ipcMain.handle(
    CHANNELS.sourceList,
    wrap(() => sources.list())
  )
  ipcMain.handle(
    CHANNELS.searchRun,
    wrap((arg) => search.search(arg))
  )
  ipcMain.handle(
    CHANNELS.searchRunGrouped,
    wrap((arg) => search.searchGrouped(arg))
  )
  ipcMain.handle(
    CHANNELS.searchRunSource,
    wrap((arg) => search.searchSource(arg))
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
    CHANNELS.settingsPickDir,
    wrap(() => settings.pickDir())
  )
  ipcMain.handle(
    CHANNELS.settingsCleanCache,
    wrap(() => settings.cleanCache())
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
    CHANNELS.downloadEstimate,
    wrap((arg) => download.estimate(arg))
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
    CHANNELS.downloadRecover,
    wrap(() => recovery)
  )
  ipcMain.handle(
    CHANNELS.downloadStartQueue,
    wrap(() => download.startQueue())
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
  ipcMain.handle(
    CHANNELS.libraryList,
    wrap((arg) => library.list(arg ?? {}))
  )
  ipcMain.handle(
    CHANNELS.libraryOpen,
    wrap((arg) => library.open(arg))
  )
  ipcMain.handle(
    CHANNELS.libraryReveal,
    wrap((arg) => library.reveal(arg))
  )
  ipcMain.handle(
    CHANNELS.libraryCopyPath,
    wrap((arg) => library.copyPath(arg))
  )
  ipcMain.handle(
    CHANNELS.libraryProps,
    wrap((arg) => library.props(arg))
  )
  ipcMain.handle(
    CHANNELS.libraryRename,
    wrap((arg) => library.rename(arg))
  )
  ipcMain.handle(
    CHANNELS.libraryMove,
    wrap((arg) => library.move(arg))
  )
  ipcMain.handle(
    CHANNELS.libraryTrash,
    wrap((arg) => library.trash(arg))
  )
  ipcMain.handle(
    CHANNELS.libraryPickDir,
    wrap(() => library.pickDir())
  )
  ipcMain.handle(
    CHANNELS.favoriteToggle,
    wrap((arg) => favorite.toggle(arg))
  )
  ipcMain.handle(
    CHANNELS.favoriteAdd,
    wrap((arg) => favorite.add(arg))
  )
  ipcMain.handle(
    CHANNELS.favoriteRemove,
    wrap((arg) => favorite.remove(arg))
  )
  ipcMain.handle(
    CHANNELS.favoriteList,
    wrap((arg) => favorite.list(arg ?? {}))
  )
  ipcMain.handle(
    CHANNELS.favoriteIds,
    wrap(() => favorite.ids())
  )

  return { shutdown: () => engine.shutdown() }
}
