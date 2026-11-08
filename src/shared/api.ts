import type {
  AssetDetail,
  SearchPageResult,
  SearchQuery,
  SearchResultItem,
  SourceInfo
} from './types'
import type { AppError } from './errors'

/** preload 暴露给渲染层的白名单接口；渲染层只能通过它访问主进程 */
export interface KithoardApi {
  source: {
    list: () => Promise<ApiResult<SourceInfo[]>>
  }
  search: {
    run: (query: SearchQuery) => Promise<ApiResult<SearchPageResult>>
  }
  asset: {
    detail: (assetId: number) => Promise<ApiResult<AssetDetail>>
    /** 读本地已落库的最近记录；limit 不传由主进程给默认值 */
    recent: (limit?: number) => Promise<ApiResult<SearchResultItem[]>>
  }
  settings: {
    get: (key: string) => Promise<ApiResult<unknown>>
    set: (key: string, value: unknown) => Promise<ApiResult<{ ok: true }>>
  }
  clipboard: {
    writeText: (text: string) => Promise<ApiResult<{ ok: true }>>
  }
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: AppError }
