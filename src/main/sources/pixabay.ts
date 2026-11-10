import { makeError } from '@shared/errors'
import type { SearchQuery } from '@shared/types'
import { fetchJson } from './http'
import {
  buildByIdUrl,
  buildSearchUrl,
  PIXABAY_ID,
  PIXABAY_NAME,
  parsePage,
  parseRateLimitRemaining,
  parseSingleHit,
  type PixabayPayload
} from './pixabay-map'
import type { AssetSource, DownloadPlan, SearchPage } from './types'

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
      requiresSourceNotice: true,
      // 图片直链两天即失效，下载前按 id 重新取一次；视频是永久链接，不续期
      refreshableDownloadTypes: ['image']
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
    async resolveDownload(remoteId: string, signal: AbortSignal): Promise<DownloadPlan> {
      const key = apiKey()
      if (!key) throw makeError('E_AUTH_REQUIRED')
      const result = await fetchJson<PixabayPayload>(buildByIdUrl(key, remoteId), {
        signal,
        // 续期必须拿当下有效的签名直链，命中 24 小时缓存会让链接被提前用掉
        skipCache: true,
        timeoutMs: 12_000
      })
      const url = parseSingleHit(result.data)?.largeImageURL
      if (!url) throw makeError('E_SOURCE_DOWN', 'no largeImageURL')
      // 文件名由下载服务按标题生成，这里不重复实现一套命名规则
      return { url, fileName: '', headers: {} }
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
