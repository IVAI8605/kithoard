import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { CHANNELS } from '@shared/channels'
import { fail, isAppError, makeError, ok, type Envelope } from '@shared/errors'
import type { AgentScope } from '@shared/agent'
import { createAgentGateway, type AgentGateway } from '../agent/gateway'
import { cleanCache } from '../cache/clean'
import { createBrowserService } from '../browser'
import { createDownloadEngine } from '../download/engine'
import { log } from '../log'
import { getApiKey } from '../settings'
import { createSourceRegistry, refreshDownloadUrl } from '../sources'
import type { SourceRegistry } from '../sources/registry'
import { createClipboardService } from '../services/clipboard'
import { createDetailService } from '../services/detail'
import { createDownloadService } from '../services/download'
import { createFavoriteService } from '../services/favorite'
import { createLibraryService } from '../services/library'
import { createMediaService } from '../services/media'
import { createQuarantineService } from '../services/quarantine'
import { runStartupRecovery } from '../services/recovery'
import { createRecentService } from '../services/recent'
import { createResetService } from '../services/reset'
import { createSearchService } from '../services/search'
import { createSettingsService } from '../services/settings'
import { createSourceService } from '../services/sources'

type Handler = (arg: unknown) => Promise<unknown> | unknown

/** agent 相关通道的参数都是「单字段对象」，统一在这里降级成空对象，避免每处重复判空 */
function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

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
    quarantineDir: path.join(deps.userDataDir, 'quarantine'),
    // 图片直链两天即失效：下载前按 id 向来源取一次新链接，失败由引擎回退库内链接
    refreshUrl: (target, signal) => refreshDownloadUrl(registry, target, signal)
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
  // 清空下载历史前需要先停引擎，所以 reset 也必须在 engine 之后创建
  const reset = createResetService({ engine })
  const media = createMediaService({ notify: emit })
  const browser = createBrowserService({ notify: emit })

  // V1.1 Agent 网关：与界面共用同一批 service，避免两套校验规则漂移。
  // 默认关闭，只有用户在设置页显式开启后才开始监听命名管道。
  const agent: AgentGateway = createAgentGateway({
    services: { sources, search, detail, download, library, favorite, quarantine, media },
    appVersion: app.getVersion(),
    userDataDir: deps.userDataDir,
    notify: emit
  })
  agent.sync()

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
    CHANNELS.settingsBackup,
    wrap(() => settings.exportBackup())
  )
  ipcMain.handle(
    CHANNELS.settingsRestore,
    wrap(() => settings.importBackup())
  )
  ipcMain.handle(
    CHANNELS.settingsClearData,
    wrap((arg) => reset.clearData(arg))
  )
  ipcMain.handle(
    CHANNELS.mediaStart,
    wrap((arg) => media.start(arg))
  )
  ipcMain.handle(
    CHANNELS.mediaCancel,
    wrap((arg) => media.cancel(arg))
  )
  ipcMain.handle(
    CHANNELS.mediaList,
    wrap(() => media.list())
  )
  ipcMain.handle(
    CHANNELS.browserOpen,
    wrap((arg) => browser.open(arg))
  )
  ipcMain.handle(
    CHANNELS.browserNavigate,
    wrap((arg) => browser.navigate(arg))
  )
  ipcMain.handle(
    CHANNELS.browserBounds,
    wrap((arg) => browser.setBounds(arg))
  )
  ipcMain.handle(
    CHANNELS.browserHide,
    wrap(() => browser.hide())
  )
  ipcMain.handle(
    CHANNELS.browserRecent,
    wrap(() => browser.recent())
  )
  ipcMain.handle(
    CHANNELS.browserExternal,
    wrap((arg) => browser.external(arg))
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

  ipcMain.handle(
    CHANNELS.agentStatus,
    wrap(() => agent.status())
  )
  ipcMain.handle(
    CHANNELS.agentSetEnabled,
    wrap((arg) => agent.setEnabled(readRecord(arg).enabled === true))
  )
  ipcMain.handle(
    CHANNELS.agentIssueToken,
    wrap((arg) => {
      const record = readRecord(arg)
      const name = typeof record.name === 'string' ? record.name : ''
      // 只接受三个可授予作用域；destructive 永远进不来，必须逐次审批
      const scopes = Array.isArray(record.scopes)
        ? record.scopes.filter(
            (item): item is AgentScope =>
              item === 'read' || item === 'acquire' || item === 'organize'
          )
        : (['read', 'acquire'] as AgentScope[])
      return agent.issueToken(name, scopes)
    })
  )
  ipcMain.handle(
    CHANNELS.agentRevoke,
    wrap((arg) => {
      const clientId = readRecord(arg).clientId
      if (typeof clientId !== 'string' || !clientId) throw makeError('E_INVALID_ARG', 'clientId')
      return agent.revoke(clientId)
    })
  )
  ipcMain.handle(
    CHANNELS.agentRevokeAll,
    wrap(() => agent.revokeAll())
  )
  ipcMain.handle(
    CHANNELS.agentAudit,
    wrap((arg) => {
      const limit = readRecord(arg).limit
      return agent.auditRecent(typeof limit === 'number' ? limit : 50)
    })
  )
  ipcMain.handle(
    CHANNELS.agentAuditPath,
    wrap(() => agent.auditPath())
  )
  ipcMain.handle(
    CHANNELS.agentDecide,
    wrap((arg) => {
      const record = readRecord(arg)
      const approvalId = record.approvalId
      if (typeof approvalId !== 'string' || !approvalId) {
        throw makeError('E_INVALID_ARG', 'approvalId')
      }
      return agent.decide(approvalId, record.allow === true)
    })
  )

  return {
    shutdown: () => {
      // 先关网关再停下载：避免退出瞬间还有 agent 请求进来读到已关闭的库
      agent.stop()
      engine.shutdown()
    }
  }
}
