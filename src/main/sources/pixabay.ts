import { makeError } from '@shared/errors'
import type { SearchQuery } from '@shared/types'
import { fetchJson } from './http'
import {
  buildSearchUrl,
  PIXABAY_ID,
  PIXABAY_NAME,
  parsePage,
  parseRateLimitRemaining,
  type PixabayPayload
} from './pixabay-map'
import type { AssetSource, SearchPage } from './types'

export function createPixabaySource(deps: {
  getApiKey: () => string
  cacheDir: string
}): AssetSource {
  const apiKey = (): string => deps.getApiKey()

  return {
    id: PIXABAY_ID,
    name: PIXABAY_NAME,
    capabilities: {
      types: ['image', 'video'],
      requiresApiKey: true,
      attributionRequired: true,
      maxPageSize: 20,
      // B6：展示搜索结果时必须告知来源，这是 API 使用条件，与内容许可无关
      requiresSourceNotice: true
    },
    isReady: () => apiKey().length > 0,
    async search(query: SearchQuery, signal: AbortSignal): Promise<SearchPage> {
      const key = apiKey()
      if (!key) throw makeError('E_AUTH_REQUIRED')
      const url = buildSearchUrl(key, query)
      const result = await fetchJson<PixabayPayload>(url, {
        signal,
        cacheDir: deps.cacheDir,
        timeoutMs: 12_000
      })
      const parsed = parsePage(result.data, query)
      return {
        ...parsed,
        page: query.page,
        pageSize: query.pageSize,
        rateLimitRemaining: parseRateLimitRemaining(result.headers)
      }
    },
    async getDetail(): Promise<never> {
      // Pixabay 没有按 id 查详情的接口；详情一律读本地 assets 表
      throw makeError('E_UNSUPPORTED', 'pixabay detail is served from local db')
    },
    async resolveDownload(): Promise<never> {
      // 下载能力在 V0.2 交付
      throw makeError('E_UNSUPPORTED', 'download comes in V0.2')
    },
    attributionOf(meta) {
      if (!meta.pageUrl) return null
      const label = meta.type === 'video' ? '视频来自 Pixabay' : '图片来自 Pixabay'
      const joiner = meta.pageUrl.includes('?') ? '&' : '?'
      return {
        text: label,
        url: `${meta.pageUrl}${joiner}utm_source=kithoard&utm_medium=referral`
      }
    }
  }
}
