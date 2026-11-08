import type {
  AssetDetail,
  DownloadProgressEvent,
  DownloadStateEvent,
  DownloadTask,
  QuarantineItem,
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
  /** V0.2 下载队列：队列操作与两类实时事件 */
  download: {
    enqueue: (assetIds: number[]) => Promise<ApiResult<{ taskIds: string[] }>>
    pause: (taskId: string) => Promise<ApiResult<{ ok: true }>>
    cancel: (taskId: string) => Promise<ApiResult<{ ok: true }>>
    resume: (taskId: string) => Promise<ApiResult<{ ok: true }>>
    /** 重试失败任务；超过 3 次需要界面二次确认后带 confirm=true 再调 */
    retry: (taskId: string, confirm?: boolean) => Promise<ApiResult<{ ok: true }>>
    reorder: (orderedIds: string[]) => Promise<ApiResult<{ ok: true }>>
    list: () => Promise<ApiResult<DownloadTask[]>>
    /** 返回取消订阅函数；页面卸载时调用，避免监听器越积越多 */
    onProgress: (listener: (event: DownloadProgressEvent) => void) => () => void
    onState: (listener: (event: DownloadStateEvent) => void) => () => void
  }
  /** V0.2 隔离区：恢复回原路径，或移入系统回收站 */
  quarantine: {
    list: () => Promise<ApiResult<QuarantineItem[]>>
    restore: (id: number) => Promise<ApiResult<{ ok: true }>>
    discard: (id: number) => Promise<ApiResult<{ ok: true }>>
  }
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: AppError }
