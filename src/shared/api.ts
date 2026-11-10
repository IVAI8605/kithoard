import type {
  AssetType,
  AssetDetail,
  AppNavigateTarget,
  BackupExportResult,
  BackupImportResult,
  BrowserRecentItem,
  BrowserState,
  ClearResult,
  ClearScope,
  DownloadProgressEvent,
  DownloadStateEvent,
  DownloadTask,
  DownloadEstimate,
  LocalFilePage,
  LocalFileProps,
  LocalFileQuery,
  MediaProgressEvent,
  MediaProcessOptions,
  MediaTask,
  QuarantineItem,
  RecoveryReport,
  FavoritePage,
  GroupedSearchResult,
  SearchPageResult,
  SearchQuery,
  SearchResultItem,
  SourceInfo
} from './types'
import type { AppError } from './errors'
import type {
  AgentApprovalTicket,
  AgentAuditEntry,
  AgentClientRecord,
  AgentScope,
  AgentStatus
} from './agent'

/** preload 暴露给渲染层的白名单接口；渲染层只能通过它访问主进程 */
export interface KithoardApi {
  source: {
    list: () => Promise<ApiResult<SourceInfo[]>>
  }
  search: {
    run: (query: SearchQuery) => Promise<ApiResult<SearchPageResult>>
    /** 按启用源分组搜索；每组独立分页，不做跨源合并排序 */
    runGrouped: (query: SearchQuery) => Promise<ApiResult<GroupedSearchResult>>
    /** 只搜索指定源，用于组内翻页 */
    runSource: (sourceId: string, query: SearchQuery) => Promise<ApiResult<SearchPageResult>>
  }
  asset: {
    detail: (assetId: number) => Promise<ApiResult<AssetDetail>>
    /** 读本地已落库的最近记录；limit 不传由主进程给默认值 */
    recent: (limit?: number) => Promise<ApiResult<SearchResultItem[]>>
  }
  settings: {
    get: (key: string) => Promise<ApiResult<unknown>>
    set: (key: string, value: unknown) => Promise<ApiResult<{ ok: true }>>
    /** 选下载目录；取消返回 null */
    pickDir: () => Promise<ApiResult<{ path: string | null }>>
    /** 手动清理缓存；返回清理条数与字节数 */
    cleanCache: () => Promise<ApiResult<{ removed: number; bytes: number }>>
    /** 导出数据备份；用户取消时 path 为 null */
    exportBackup: () => Promise<ApiResult<BackupExportResult>>
    /** 导入数据备份；用户取消时 summary 为 null */
    importBackup: () => Promise<ApiResult<BackupImportResult>>
    /** 按范围清空收藏/下载历史/个人设置；不删除本地素材文件 */
    clearData: (scope: ClearScope) => Promise<ApiResult<ClearResult>>
  }
  clipboard: {
    writeText: (text: string) => Promise<ApiResult<{ ok: true }>>
  }
  /** V0.2 下载队列：队列操作与两类实时事件 */
  download: {
    /** confirmLarge 用于「超过 200 MB 需二次确认」的场景，普通入队不用传 */
    enqueue: (
      assetIds: number[],
      options?: { confirmLarge?: boolean }
    ) => Promise<ApiResult<{ taskIds: string[] }>>
    /** 批量确认框用：只返回数量与合计字节，bytes 为 null 表示有素材大小未知 */
    estimate: (assetIds: number[]) => Promise<ApiResult<DownloadEstimate>>
    /** 取回启动恢复报告；主进程启动时已执行过，不会重复扫描 */
    recover: () => Promise<ApiResult<RecoveryReport>>
    /** 开始/继续处理排队任务；用户没在恢复弹窗点确认前不应调用 */
    startQueue: () => Promise<ApiResult<{ ok: true }>>
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
  /**
   * V0.2 本地素材：查看、系统级打开与文件整理。
   * 删除只进回收站；移动后由主进程同步库记录与下载任务的目标路径。
   */
  library: {
    list: (query?: LocalFileQuery) => Promise<ApiResult<LocalFilePage>>
    open: (id: number) => Promise<ApiResult<{ ok: true }>>
    reveal: (id: number) => Promise<ApiResult<{ ok: true }>>
    copyPath: (id: number) => Promise<ApiResult<{ ok: true }>>
    props: (id: number) => Promise<ApiResult<LocalFileProps>>
    /** newName 只需主体名；带扩展名时必须与原扩展名一致 */
    rename: (id: number, newName: string) => Promise<ApiResult<{ ok: true; path: string }>>
    /** failed 是未能移动的 id，界面按「部分成功」提示 */
    move: (ids: number[], targetDir: string) => Promise<ApiResult<{ ok: true; failed: number[] }>>
    trash: (ids: number[]) => Promise<ApiResult<{ ok: true; failed: number[] }>>
    /** 用户在系统对话框里取消时返回 null，界面不应把它当成错误 */
    pickDir: () => Promise<ApiResult<{ path: string | null }>>
  }
  /** V0.3 收藏夹：收藏/取消、批量收藏、批量取消、分页列表 */
  favorite: {
    toggle: (assetId: number) => Promise<ApiResult<{ ok: true; favorited: boolean }>>
    add: (assetIds: number[]) => Promise<ApiResult<{ ok: true; added: number }>>
    remove: (assetIds: number[]) => Promise<ApiResult<{ ok: true; removed: number }>>
    list: (query?: { type?: AssetType; keyword?: string; page?: number; pageSize?: number }) => Promise<ApiResult<FavoritePage>>
    /** 全部已收藏的素材 id，用于卡片与详情页的状态联动 */
    ids: () => Promise<ApiResult<number[]>>
  }
  /** V0.4 图片处理：转换、压缩、编辑；批量逐条推送进度 */
  media: {
    start: (fileIds: number[], options: MediaProcessOptions) => Promise<ApiResult<{ taskId: string }>>
    cancel: (taskId: string) => Promise<ApiResult<{ ok: true }>>
    list: () => Promise<ApiResult<MediaTask[]>>
    /** 返回取消订阅函数；页面卸载时调用 */
    onProgress: (listener: (event: MediaProgressEvent) => void) => () => void
  }
  /** V0.6 受限站内浏览：地址栏、前进后退、最近访问；安全策略全在主进程 */
  browser: {
    open: (url: string) => Promise<ApiResult<BrowserState>>
    /** go 需要 url；back/forward/reload/stop 不需要 */
    navigate: (
      action: 'back' | 'forward' | 'reload' | 'stop' | 'go',
      url?: string
    ) => Promise<ApiResult<BrowserState>>
    /** 渲染层占位区域的窗口坐标（DIP） */
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<ApiResult<{ ok: true }>>
    hide: () => Promise<ApiResult<{ ok: true }>>
    recent: () => Promise<ApiResult<BrowserRecentItem[]>>
    external: (url: string) => Promise<ApiResult<{ ok: true }>>
    onState: (listener: (event: BrowserState) => void) => () => void
  }
  /** V1.2.0 系统托盘：主进程请求跳转页面（home=主页面 / settings=设置） */
  app: {
    onNavigate: (listener: (target: AppNavigateTarget) => void) => () => void
  }
  agent: {
    status: () => Promise<ApiResult<AgentStatus>>
    /** 开启后网关才开始监听命名管道；关闭会立即断开所有连接 */
    setEnabled: (enabled: boolean) => Promise<ApiResult<AgentStatus>>
    /** 明文令牌只在这里返回一次，界面必须提示用户立即复制 */
    issueToken: (name: string, scopes: AgentScope[]) => Promise<ApiResult<{ token: string; client: AgentClientRecord }>>
    revoke: (clientId: string) => Promise<ApiResult<AgentStatus>>
    revokeAll: () => Promise<ApiResult<AgentStatus>>
    audit: (limit: number) => Promise<ApiResult<AgentAuditEntry[]>>
    auditPath: () => Promise<ApiResult<string>>
    /** 两阶段审批：用户在应用内点允许或拒绝 */
    decide: (approvalId: string, allow: boolean) => Promise<ApiResult<AgentStatus>>
    onApproval: (listener: (ticket: AgentApprovalTicket) => void) => () => void
  }
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: AppError }
