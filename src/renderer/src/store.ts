import { create } from 'zustand'
import type { AppError } from '@shared/errors'
import type {
  DownloadProgressEvent,
  DownloadStateEvent,
  DownloadTask,
  QuarantineItem,
  RecoveryReport,
  SearchGroup,
  SearchResultItem,
  SearchableType,
  SourceInfo
} from '@shared/types'

type LoadStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error'
type KeyStorage = 'encrypted' | 'plaintext'

interface AppState {
  sources: SourceInfo[]
  sourcesLoaded: boolean
  keyStorage: KeyStorage | null
  settingsOpen: boolean
  keyword: string
  type: SearchableType
  pageSize: number
  status: LoadStatus
  /** 按源分组的结果；每组独立分页，界面不做跨源合并排序 */
  groups: SearchGroup[]
  error: AppError | null
  /** 本地已落库的最近记录；与搜索结果分开存，避免互相覆盖 */
  recent: SearchResultItem[]
  recentLoaded: boolean
  /** V0.2 下载队列：任务、隔离区、启动恢复报告三份数据分开存 */
  downloads: DownloadTask[]
  downloadsLoaded: boolean
  quarantineItems: QuarantineItem[]
  quarantineLoaded: boolean
  recovery: RecoveryReport | null
  /** V0.3 收藏：id 集合用于卡片/详情联动，列表数据由收藏页自己维护 */
  favoriteIds: number[]
  favoriteLoaded: boolean
  loadSources: () => Promise<void>
  loadRecent: () => Promise<void>
  loadFavoriteIds: () => Promise<void>
  toggleFavorite: (assetId: number) => Promise<AppError | null>
  addFavorites: (assetIds: number[]) => Promise<AppError | null>
  removeFavorites: (assetIds: number[]) => Promise<AppError | null>
  setKeyword: (value: string) => void
  setType: (value: SearchableType) => void
  setSettingsOpen: (open: boolean) => void
  runSearch: () => Promise<void>
  /** 组内翻页：只请求该源，其他组保持不动 */
  loadGroupPage: (sourceId: string, page: number) => Promise<void>
  saveApiKey: (sourceId: string, key: string) => Promise<AppError | null>
  toggleSource: (id: string, enabled: boolean) => Promise<AppError | null>
  setRecovery: (report: RecoveryReport) => void
  loadDownloads: () => Promise<void>
  loadQuarantine: () => Promise<void>
  applyProgress: (event: DownloadProgressEvent) => void
  applyState: (event: DownloadStateEvent) => void
  downloadAssets: (assetIds: number[], confirmLarge?: boolean) => Promise<AppError | null>
  pauseTask: (taskId: string) => Promise<AppError | null>
  cancelTask: (taskId: string) => Promise<AppError | null>
  resumeTask: (taskId: string) => Promise<AppError | null>
  retryTask: (taskId: string, confirm?: boolean) => Promise<AppError | null>
  reorderTasks: (orderedIds: string[]) => Promise<AppError | null>
  startQueue: () => Promise<AppError | null>
  restoreQuarantine: (id: number) => Promise<AppError | null>
  discardQuarantine: (id: number) => Promise<AppError | null>
}

export const useAppStore = create<AppState>((set, get) => ({
  sources: [],
  sourcesLoaded: false,
  keyStorage: null,
  settingsOpen: false,
  keyword: '',
  type: 'image',
  pageSize: 20,
  status: 'idle',
  groups: [],
  error: null,
  recent: [],
  recentLoaded: false,
  downloads: [],
  downloadsLoaded: false,
  quarantineItems: [],
  quarantineLoaded: false,
  recovery: null,
  favoriteIds: [],
  favoriteLoaded: false,

  loadSources: async () => {
    const [sourceResult, storageResult] = await Promise.all([
      window.api.source.list(),
      window.api.settings.get('app.keyStorage')
    ])
    set({
      sourcesLoaded: true,
      sources: sourceResult.ok ? sourceResult.data : [],
      keyStorage:
        storageResult.ok && (storageResult.data === 'encrypted' || storageResult.data === 'plaintext')
          ? storageResult.data
          : null
    })
  },

  // 只读本地库，不联网；失败也置为已加载，避免首页一直停在「加载中」
  loadRecent: async () => {
    const result = await window.api.asset.recent(12)
    set({ recentLoaded: true, recent: result.ok ? result.data : [] })
  },

  setKeyword: (value) => set({ keyword: value }),
  setType: (value) => set({ type: value }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),

  runSearch: async () => {
    const { keyword, type, pageSize } = get()
    const trimmed = keyword.trim()
    if (!trimmed) return
    set({ status: 'loading', error: null })

    const result = await window.api.search.runGrouped({
      keyword: trimmed,
      type,
      page: 1,
      pageSize
    })
    if (!result.ok) {
      set({ status: 'error', error: result.error, groups: [] })
      return
    }

    const groups = result.data.groups
    // 全部失败才算整体错误；只要有一个源出结果，就让用户先看到能看的部分
    const allFailed = groups.length > 0 && groups.every((group) => group.error !== null)
    const hasItems = groups.some((group) => group.items.length > 0)
    set({
      groups,
      status: allFailed ? 'error' : hasItems ? 'ready' : 'empty',
      error: allFailed ? (groups[0]?.error ?? null) : null
    })
  },

  loadGroupPage: async (sourceId, page) => {
    const { keyword, type, pageSize } = get()
    const trimmed = keyword.trim()
    if (!trimmed) return

    const result = await window.api.search.runSource(sourceId, {
      keyword: trimmed,
      type,
      page,
      pageSize
    })
    set((state) => ({
      groups: state.groups.map((group) => {
        if (group.sourceId !== sourceId) return group
        if (!result.ok) return { ...group, error: result.error, items: [] }
        return { ...group, ...result.data, error: null }
      })
    }))
  },

  saveApiKey: async (sourceId, key) => {
    const result = await window.api.settings.set(`source.apiKey.${sourceId}`, key)
    if (!result.ok) return result.error
    await get().loadSources()
    return null
  },

  toggleSource: async (id, enabled) => {
    const enabledIds = get()
      .sources.filter((source) => source.enabled)
      .map((source) => source.id)
    const next = enabled
      ? [...new Set([...enabledIds, id])]
      : enabledIds.filter((sourceId) => sourceId !== id)
    // 至少保留一个来源；本地先拦一次，主进程还会再校验
    if (next.length === 0) return { code: 'E_INVALID_ARG', message: '至少保留一个素材来源', retryable: false }

    const result = await window.api.settings.set('source.enabled', next)
    if (!result.ok) return result.error
    await get().loadSources()
    return null
  },

  setRecovery: (report) => set({ recovery: report }),

  loadFavoriteIds: async () => {
    const result = await window.api.favorite.ids()
    set({ favoriteLoaded: true, favoriteIds: result.ok ? result.data : [] })
  },

  // 收藏状态先以主进程返回为准，再刷新 id 集合，避免界面出现「点了没反应」
  toggleFavorite: async (assetId) => {
    const result = await window.api.favorite.toggle(assetId)
    if (!result.ok) return result.error
    await get().loadFavoriteIds()
    return null
  },

  addFavorites: async (assetIds) => {
    const result = await window.api.favorite.add(assetIds)
    if (!result.ok) return result.error
    await get().loadFavoriteIds()
    return null
  },

  removeFavorites: async (assetIds) => {
    const result = await window.api.favorite.remove(assetIds)
    if (!result.ok) return result.error
    await get().loadFavoriteIds()
    return null
  },

  // 队列状态只从主进程读：渲染层不做乐观更新，避免界面显示「已暂停」但库里还在下载
  loadDownloads: async () => {
    const result = await window.api.download.list()
    set({ downloadsLoaded: true, downloads: result.ok ? result.data : [] })
  },

  loadQuarantine: async () => {
    const result = await window.api.quarantine.list()
    set({ quarantineLoaded: true, quarantineItems: result.ok ? result.data : [] })
  },

  applyProgress: (event) => {
    set((state) => ({
      downloads: state.downloads.map((task) =>
        task.id === event.taskId
          ? { ...task, receivedBytes: event.receivedBytes, totalBytes: event.totalBytes }
          : task
      )
    }))
  },

  applyState: (event) => {
    set((state) => ({
      downloads: state.downloads.map((task) =>
        task.id === event.taskId
          ? {
              ...task,
              state: event.state,
              receivedBytes: event.receivedBytes,
              totalBytes: event.totalBytes,
              errorCode: event.errorCode
            }
          : task
      )
    }))
    // 终态事件不携带 retry_count / updated_at，重拉一次补齐；事件频率低，不必做增量猜
    if (event.state === 'completed' || event.state === 'canceled' || event.state === 'failed') {
      void get().loadDownloads()
    }
  },

  downloadAssets: async (assetIds, confirmLarge) => {
    const result = await window.api.download.enqueue(
      assetIds,
      confirmLarge ? { confirmLarge: true } : undefined
    )
    if (!result.ok) return result.error
    await get().loadDownloads()
    return null
  },

  pauseTask: (taskId) => runTaskAction(() => window.api.download.pause(taskId)),
  cancelTask: (taskId) => runTaskAction(() => window.api.download.cancel(taskId)),
  resumeTask: (taskId) => runTaskAction(() => window.api.download.resume(taskId)),
  retryTask: (taskId, confirm) => runTaskAction(() => window.api.download.retry(taskId, confirm)),

  reorderTasks: async (orderedIds) => {
    const result = await window.api.download.reorder(orderedIds)
    if (!result.ok) return result.error
    await get().loadDownloads()
    return null
  },

  startQueue: async () => {
    const result = await window.api.download.startQueue()
    if (!result.ok) return result.error
    await get().loadDownloads()
    return null
  },

  restoreQuarantine: async (id) => {
    const result = await window.api.quarantine.restore(id)
    if (!result.ok) return result.error
    await Promise.all([get().loadQuarantine(), get().loadDownloads()])
    return null
  },

  discardQuarantine: async (id) => {
    const result = await window.api.quarantine.discard(id)
    if (!result.ok) return result.error
    await Promise.all([get().loadQuarantine(), get().loadDownloads()])
    return null
  }
}))

/** 队列操作的共同收尾：失败时把错误交给页面提示，成功则静默（状态会由事件推回来） */
async function runTaskAction(
  action: () => Promise<{ ok: true; data: { ok: true } } | { ok: false; error: AppError }>
): Promise<AppError | null> {
  const result = await action()
  return result.ok ? null : result.error
}
