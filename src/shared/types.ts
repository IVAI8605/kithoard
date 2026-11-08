import type { AppError } from './errors'

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

/** 按源分组的一组搜索结果；单源失败只影响该组，不拖垮其他源 */
export interface SearchGroup {
  sourceId: string
  sourceName: string
  items: SearchResultItem[]
  page: number
  pageSize: number
  totalHits: number
  hasNext: boolean
  rateLimitRemaining: number | null
  sourceNotice: { text: string; url: string } | null
  error: AppError | null
}

export interface GroupedSearchResult {
  groups: SearchGroup[]
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

/**
 * 启动恢复报告（§5.4）。
 * 界面据此决定是否弹「继续上次的队列」，主进程只负责把库状态与磁盘对齐。
 */
export interface RecoveryReport {
  /** 本次扫描的未终态任务数 */
  scanned: number
  /** 状态或字节被按磁盘校正的条数 */
  corrected: number
  /** 补登 local_files 的条数（rename 后崩溃） */
  repaired: number
  /** 被校正为 failed 的条数 */
  failed: number
  /** 仍在排队、等用户决定是否开始的任务数 */
  pendingQueued: number
  /** 隔离区里仍有文件的条数 */
  quarantined: number
}

/** 批量下载前的体量预估；bytes 为 null 表示至少一条大小未知，不做估算 */
export interface DownloadEstimate {
  count: number
  bytes: number | null
}

/** 收藏夹的一条记录；素材被清空后标题与类型为 null，记录保留 */
export interface FavoriteItem {
  id: number
  assetId: number
  title: string | null
  type: AssetType | null
  sourceId: string | null
  remoteId: string | null
  createdAt: number
}

/** `favorite:list` 分页结果 */
export interface FavoritePage {
  items: FavoriteItem[]
  total: number
  page: number
  pageSize: number
}

/** 本地素材在磁盘上的三种状态；quarantined 只出现在隔离区，本地素材页不展示 */
export type LocalFileStatus = 'present' | 'missing' | 'quarantined'

/** 本地素材页的一条记录；标题与类型来自关联素材，素材被清空后为 null */
export interface LocalFileItem {
  id: number
  assetId: number | null
  downloadId: string | null
  title: string | null
  type: AssetType | null
  fileName: string
  path: string
  status: LocalFileStatus
  sizeBytes: number | null
  createdAt: number
  updatedAt: number
}

/** `library:list` 入参；type 不传表示全部类型，keyword 为空表示不筛选 */
export interface LocalFileQuery {
  type?: AssetType
  keyword?: string
  page?: number
  pageSize?: number
}

export interface LocalFilePage {
  items: LocalFileItem[]
  total: number
  page: number
  pageSize: number
}

/** 属性面板数据；时间统一 Unix 毫秒，ext 不含点，没有扩展名时为空串 */
export interface LocalFileProps {
  id: number
  path: string
  size: number
  ext: string
  createdAt: number
  modifiedAt: number
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

/**
 * 备份导入摘要（§5.7）：只给界面展示条数，不暴露内部 id。
 * 导入不做「部分成功」——要么整份写入，要么回滚后报错。
 */
export interface RestoreSummary {
  addedAssets: number
  addedFavorites: number
  addedDownloads: number
  addedLocalFiles: number
  /** 因目标路径已存在而跳过的条数 */
  existingDownloads: number
  existingLocalFiles: number
  /** 本机磁盘上找不到文件的条数；记录标 missing，不阻断导入 */
  missingPaths: number
}

/** `settings:backup` 返回：用户取消时 path 为 null，counts 全 0 */
export interface BackupExportResult {
  path: string | null
  bytes: number
  counts: {
    assets: number
    favorites: number
    downloads: number
    localFiles: number
  }
}

/** `settings:restore` 返回：用户取消时 summary 为 null */
export interface BackupImportResult {
  path: string | null
  summary: RestoreSummary | null
}

/**
 * 清空数据的范围（§7.5-7）。
 * 三类数据各自独立；all 只合并这三类，不删本地素材记录与磁盘文件。
 */
export type ClearScope = 'favorites' | 'downloads' | 'settings' | 'all'

export interface ClearResult {
  favorites: number
  downloads: number
  settings: number
}

/**
 * V0.4 图片输出格式。
 * BMP 只支持作为输入：sharp 没有 BMP 编码器，强行列出会让界面出现一个必失败的选项。
 */
export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif'

export type ImageAction = 'convert' | 'compress' | 'edit'

/** V0.5 音视频处理动作；图片与音视频共用同一套媒体处理通道 */
export type MediaAction =
  | ImageAction
  | 'videoConvert'
  | 'videoCompress'
  | 'videoScreenshot'
  | 'audioConvert'
  | 'audioCompress'
  | 'audioExtract'

/** 裁剪坐标以左上角为原点，单位像素；旋转为顺时针角度 */
export interface ImageEditOptions {
  crop?: { left: number; top: number; width: number; height: number }
  rotate?: number
  flip?: 'horizontal' | 'vertical'
  resize?: { width?: number; height?: number }
}

export interface ImageProcessOptions {
  action: ImageAction
  /** convert 必填；compress/edit 不填则沿用原格式 */
  format?: ImageFormat
  /** 1–100；不填由主进程按格式给默认值 */
  quality?: number
  edit?: ImageEditOptions
}

export interface VideoConvertOptions {
  action: 'videoConvert'
  crf?: number
  width?: number
  height?: number
  bitrate?: string
}

export interface VideoCompressOptions {
  action: 'videoCompress'
}

export interface VideoScreenshotOptions {
  action: 'videoScreenshot'
  /** 指定时间，如 "00:00:05" */
  at: string
}

export interface AudioConvertOptions {
  action: 'audioConvert'
  bitrate?: string
  format?: 'mp3' | 'aac' | 'wav' | 'flac'
}

export interface AudioCompressOptions {
  action: 'audioCompress'
}

export interface AudioExtractOptions {
  action: 'audioExtract'
  start: string
  end: string
}

/** V0.4/V0.5 媒体处理入参；图片与音视频共用同一套通道 */
export type MediaProcessOptions =
  | ImageProcessOptions
  | VideoConvertOptions
  | VideoCompressOptions
  | VideoScreenshotOptions
  | AudioConvertOptions
  | AudioCompressOptions
  | AudioExtractOptions

export type MediaTaskState = 'queued' | 'running' | 'completed' | 'failed'

export interface MediaTaskItem {
  /** 对应的 local_files.id，界面用它定位是哪一条素材 */
  fileId: number
  fileName: string
  state: MediaTaskState
  /** 处理后的新路径；压缩覆盖原文件时与原路径相同 */
  outputPath?: string
  /** 失败原因给中文可读文案，不塞英文异常 */
  error?: string
}

export interface MediaTask {
  taskId: string
  action: MediaAction
  total: number
  done: number
  failed: number
  items: MediaTaskItem[]
}

/** `media:progress` 每完成一条推送一次，界面据此更新进度与失败列表 */
export interface MediaProgressEvent {
  taskId: string
  done: number
  total: number
  failed: number
  item: MediaTaskItem
}
