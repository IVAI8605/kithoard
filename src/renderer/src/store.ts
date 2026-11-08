import { create } from 'zustand'
import type { AppError } from '@shared/errors'
import type {
  SearchPageResult,
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
  page: number
  pageSize: number
  status: LoadStatus
  items: SearchResultItem[]
  result: SearchPageResult | null
  error: AppError | null
  /** 本地已落库的最近记录；与搜索结果分开存，避免互相覆盖 */
  recent: SearchResultItem[]
  recentLoaded: boolean
  loadSources: () => Promise<void>
  loadRecent: () => Promise<void>
  setKeyword: (value: string) => void
  setType: (value: SearchableType) => void
  setSettingsOpen: (open: boolean) => void
  runSearch: (nextPage?: number) => Promise<void>
  saveApiKey: (key: string) => Promise<AppError | null>
  toggleSource: (id: string, enabled: boolean) => Promise<AppError | null>
}

export const useAppStore = create<AppState>((set, get) => ({
  sources: [],
  sourcesLoaded: false,
  keyStorage: null,
  settingsOpen: false,
  keyword: '',
  type: 'image',
  page: 1,
  pageSize: 20,
  status: 'idle',
  items: [],
  result: null,
  error: null,
  recent: [],
  recentLoaded: false,

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

  runSearch: async (nextPage) => {
    const { keyword, type, pageSize } = get()
    const trimmed = keyword.trim()
    if (!trimmed) return
    const page = nextPage ?? 1
    set({ status: 'loading', error: null, page })

    const result = await window.api.search.run({ keyword: trimmed, type, page, pageSize })
    if (!result.ok) {
      set({ status: 'error', error: result.error, items: [], result: null })
      return
    }
    set({
      status: result.data.items.length === 0 ? 'empty' : 'ready',
      items: result.data.items,
      result: result.data
    })
  },

  saveApiKey: async (key) => {
    const result = await window.api.settings.set('source.apiKey.pixabay', key)
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
  }
}))
