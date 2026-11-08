/** 通道名集中在此，主进程与 preload 共用，避免字符串漂移 */
export const CHANNELS = {
  sourceList: 'source:list',
  searchRun: 'search:run',
  assetDetail: 'asset:detail',
  // V0.1 验收第 9 条要求「关软件重开能重新打开同一条素材详情」，靠这个通道读回本地已落库的记录
  assetRecent: 'asset:recent',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  // 规划表里没有复制通道；V0.1 需要「复制来源链接」，用主进程剪贴板避免依赖页面安全上下文
  copyText: 'app:copyText',
  // V0.2 下载队列：通道名按 §6.2 的 domain:action 约定
  downloadEnqueue: 'download:enqueue',
  downloadPause: 'download:pause',
  downloadCancel: 'download:cancel',
  downloadResume: 'download:resume',
  downloadRetry: 'download:retry',
  downloadReorder: 'download:reorder',
  downloadList: 'download:list',
  // 启动恢复由主进程在注册 IPC 时执行一次，这里只把报告交给界面（§5.4）
  downloadRecover: 'download:recover',
  // 用户在恢复弹窗点「开始下载」时才启动队列；queued 不自动开始是硬规则
  downloadStartQueue: 'download:startQueue',
  // 事件通道（主进程 → 渲染层），不进 invoke 白名单
  downloadProgress: 'download:progress',
  downloadState: 'download:state',
  // V0.2 隔离区：判定有风险的文件只移入不删除，放弃时移入系统回收站
  quarantineList: 'quarantine:list',
  quarantineRestore: 'quarantine:restore',
  quarantineDiscard: 'quarantine:discard'
} as const

/** 渲染层可读的设置键白名单；不在表内的键一律拒绝 */
export const READABLE_SETTINGS = ['source.enabled', 'source.apiKey.pixabay', 'app.keyStorage'] as const

export const WRITABLE_SETTINGS = ['source.enabled', 'source.apiKey.pixabay'] as const
