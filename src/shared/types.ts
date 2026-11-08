/** 素材类型。V0.1 仅开放 image / video，其余类型在界面上置灰。 */
export type AssetType = 'image' | 'video' | 'audio' | 'font' | 'template'

/** V0.1 实际可检索的类型，避免渲染层把未支持类型误传进来 */
export type SearchableType = 'image' | 'video'

export type LicenseState = 'free' | 'paid' | 'unknown'

export interface SearchQuery {
  keyword: string
  type: SearchableType
  page: number
  pageSize: number
}

/** 适配器产出的跨源统一元数据，NULL 一律保留 null，不填 0 */
export interface AssetMeta {
  sourceId: string
  remoteId: string
  type: AssetType
  title: string
  thumbUrl: string | null
  previewUrl: string | null
  pageUrl: string | null
  width: number | null
  height: number | null
  durationSec: number | null
  sizeBytes: number | null
  license: LicenseState
  tags: string[]
}

/** 渲染层拿到的一条搜索结果；thumbName 是本机缓存文件名，不是远程地址 */
export interface SearchResultItem {
  id: number
  sourceId: string
  sourceName: string
  remoteId: string
  type: AssetType
  title: string
  thumbName: string | null
  pageUrl: string | null
  width: number | null
  height: number | null
  durationSec: number | null
  sizeBytes: number | null
  license: LicenseState
}

export interface SearchPageResult {
  items: SearchResultItem[]
  page: number
  pageSize: number
  totalHits: number
  hasNext: boolean
  /** 本分钟剩余额度；服务端未返回则为 null，不估算 */
  rateLimitRemaining: number | null
  /** Pixabay 条款要求展示来源，适配器给出固定文案；无此要求的源为 null */
  sourceNotice: { text: string; url: string } | null
}

export interface AssetDetail {
  id: number
  sourceId: string
  sourceName: string
  remoteId: string
  type: AssetType
  title: string
  thumbName: string | null
  previewUrl: string | null
  pageUrl: string | null
  width: number | null
  height: number | null
  durationSec: number | null
  sizeBytes: number | null
  license: LicenseState
  tags: string[]
  attribution: { text: string; url: string } | null
  fetchedAt: number
}

export interface SourceInfo {
  id: string
  name: string
  enabled: boolean
  ready: boolean
  requiresApiKey: boolean
  hasApiKey: boolean
  rateLimitRemaining: number | null
}

/** 下载任务状态，与版本规划 §5.3 的状态机一一对应 */
export type DownloadState =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'quarantined'

/** 下载管理页消费的一条任务；title 来自关联素材，素材被删后为 null */
export interface DownloadTask {
  id: string
  assetId: number | null
  title: string | null
  state: DownloadState
  targetPath: string
  /** 由主进程算好的文件名，渲染层不需要懂 Windows 路径规则 */
  fileName: string
  totalBytes: number | null
  receivedBytes: number
  errorCode: string | null
  retryCount: number
  sortOrder: number
  createdAt: number
  updatedAt: number
}

/** `download:progress` 事件：500 ms 合并一次，不落库 */
export interface DownloadProgressEvent {
  taskId: string
  receivedBytes: number
  totalBytes: number | null
}

/** `download:state` 事件：状态迁移时推送，收到后无需整表刷新 */
export interface DownloadStateEvent {
  taskId: string
  state: DownloadState
  receivedBytes: number
  totalBytes: number | null
  errorCode: string | null
}

/** 隔离区条目；reason 是给人看的判定原因，不是错误码 */
export interface QuarantineItem {
  id: number
  downloadId: string | null
  title: string | null
  /** 原本要放到的位置，恢复时用 */
  targetPath: string | null
  /** 文件当前所在位置 */
  path: string
  reason: string
  createdAt: number
}
