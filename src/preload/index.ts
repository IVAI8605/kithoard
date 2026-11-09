import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { KithoardApi } from '@shared/api'
import type {
  BrowserState,
  DownloadProgressEvent,
  DownloadStateEvent,
  MediaProgressEvent
} from '@shared/types'
import { CHANNELS } from '@shared/channels'

// 只暴露白名单方法；渲染层拿不到 ipcRenderer 本身，也就无法自己拼通道
const api: KithoardApi = {
  source: {
    list: () => ipcRenderer.invoke(CHANNELS.sourceList)
  },
  search: {
    run: (query) => ipcRenderer.invoke(CHANNELS.searchRun, query),
    runGrouped: (query) => ipcRenderer.invoke(CHANNELS.searchRunGrouped, query),
    runSource: (sourceId, query) => ipcRenderer.invoke(CHANNELS.searchRunSource, { sourceId, ...query })
  },
  asset: {
    detail: (assetId) => ipcRenderer.invoke(CHANNELS.assetDetail, { assetId }),
    recent: (limit) => ipcRenderer.invoke(CHANNELS.assetRecent, { limit })
  },
  settings: {
    get: (key) => ipcRenderer.invoke(CHANNELS.settingsGet, { key }),
    set: (key, value) => ipcRenderer.invoke(CHANNELS.settingsSet, { key, value }),
    pickDir: () => ipcRenderer.invoke(CHANNELS.settingsPickDir),
    cleanCache: () => ipcRenderer.invoke(CHANNELS.settingsCleanCache),
    exportBackup: () => ipcRenderer.invoke(CHANNELS.settingsBackup),
    importBackup: () => ipcRenderer.invoke(CHANNELS.settingsRestore),
    clearData: (scope) => ipcRenderer.invoke(CHANNELS.settingsClearData, { scope })
  },
  clipboard: {
    writeText: (text) => ipcRenderer.invoke(CHANNELS.copyText, { text })
  },
  download: {
    enqueue: (assetIds, options) =>
      ipcRenderer.invoke(CHANNELS.downloadEnqueue, { assetIds, ...options }),
    estimate: (assetIds) => ipcRenderer.invoke(CHANNELS.downloadEstimate, { assetIds }),
    // 恢复报告由主进程启动时算好，这里只是取回，不会触发二次扫描
    recover: () => ipcRenderer.invoke(CHANNELS.downloadRecover),
    startQueue: () => ipcRenderer.invoke(CHANNELS.downloadStartQueue),
    pause: (taskId) => ipcRenderer.invoke(CHANNELS.downloadPause, { taskId }),
    cancel: (taskId) => ipcRenderer.invoke(CHANNELS.downloadCancel, { taskId }),
    resume: (taskId) => ipcRenderer.invoke(CHANNELS.downloadResume, { taskId }),
    retry: (taskId, confirm) => ipcRenderer.invoke(CHANNELS.downloadRetry, { taskId, confirm }),
    reorder: (orderedIds) => ipcRenderer.invoke(CHANNELS.downloadReorder, { orderedIds }),
    list: () => ipcRenderer.invoke(CHANNELS.downloadList),
    onProgress: (listener) => subscribe<DownloadProgressEvent>(CHANNELS.downloadProgress, listener),
    onState: (listener) => subscribe<DownloadStateEvent>(CHANNELS.downloadState, listener)
  },
  quarantine: {
    list: () => ipcRenderer.invoke(CHANNELS.quarantineList),
    restore: (id) => ipcRenderer.invoke(CHANNELS.quarantineRestore, { id }),
    discard: (id) => ipcRenderer.invoke(CHANNELS.quarantineDiscard, { id })
  },
  library: {
    // 空查询由主进程补默认值，渲染层不需要重复写 pageSize 常量
    list: (query) => ipcRenderer.invoke(CHANNELS.libraryList, query ?? {}),
    open: (id) => ipcRenderer.invoke(CHANNELS.libraryOpen, { id }),
    reveal: (id) => ipcRenderer.invoke(CHANNELS.libraryReveal, { id }),
    copyPath: (id) => ipcRenderer.invoke(CHANNELS.libraryCopyPath, { id }),
    props: (id) => ipcRenderer.invoke(CHANNELS.libraryProps, { id }),
    rename: (id, newName) => ipcRenderer.invoke(CHANNELS.libraryRename, { id, newName }),
    move: (ids, targetDir) => ipcRenderer.invoke(CHANNELS.libraryMove, { ids, targetDir }),
    trash: (ids) => ipcRenderer.invoke(CHANNELS.libraryTrash, { ids }),
    pickDir: () => ipcRenderer.invoke(CHANNELS.libraryPickDir)
  },
  favorite: {
    toggle: (assetId) => ipcRenderer.invoke(CHANNELS.favoriteToggle, { assetId }),
    add: (assetIds) => ipcRenderer.invoke(CHANNELS.favoriteAdd, { assetIds }),
    remove: (assetIds) => ipcRenderer.invoke(CHANNELS.favoriteRemove, { assetIds }),
    list: (query) => ipcRenderer.invoke(CHANNELS.favoriteList, query ?? {}),
    ids: () => ipcRenderer.invoke(CHANNELS.favoriteIds)
  },
  media: {
    start: (fileIds, options) => ipcRenderer.invoke(CHANNELS.mediaStart, { ids: fileIds, options }),
    cancel: (taskId) => ipcRenderer.invoke(CHANNELS.mediaCancel, { taskId }),
    list: () => ipcRenderer.invoke(CHANNELS.mediaList),
    onProgress: (listener) => subscribe<MediaProgressEvent>(CHANNELS.mediaProgress, listener)
  },
  browser: {
    open: (url) => ipcRenderer.invoke(CHANNELS.browserOpen, { url }),
    navigate: (action, url) => ipcRenderer.invoke(CHANNELS.browserNavigate, { action, url }),
    setBounds: (bounds) => ipcRenderer.invoke(CHANNELS.browserBounds, bounds),
    hide: () => ipcRenderer.invoke(CHANNELS.browserHide),
    recent: () => ipcRenderer.invoke(CHANNELS.browserRecent),
    external: (url) => ipcRenderer.invoke(CHANNELS.browserExternal, { url }),
    onState: (listener) => subscribe<BrowserState>(CHANNELS.browserState, listener)
  },
  agent: {
    status: () => ipcRenderer.invoke(CHANNELS.agentStatus),
    setEnabled: (enabled) => ipcRenderer.invoke(CHANNELS.agentSetEnabled, { enabled }),
    issueToken: (name, scopes) => ipcRenderer.invoke(CHANNELS.agentIssueToken, { name, scopes }),
    revoke: (clientId) => ipcRenderer.invoke(CHANNELS.agentRevoke, { clientId }),
    revokeAll: () => ipcRenderer.invoke(CHANNELS.agentRevokeAll),
    audit: (limit) => ipcRenderer.invoke(CHANNELS.agentAudit, { limit }),
    auditPath: () => ipcRenderer.invoke(CHANNELS.agentAuditPath)
  }
}

/** 事件订阅统一返回取消函数，避免页面反复挂载后监听器叠加 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('api', api)
