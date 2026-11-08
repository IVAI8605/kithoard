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
  // V0.2 下载队列：通道名按 §6.2 的 domain:action 约定，引擎落地前先只提供队列操作
  downloadEnqueue: 'download:enqueue',
  downloadPause: 'download:pause',
  downloadCancel: 'download:cancel'
} as const

/** 渲染层可读的设置键白名单；不在表内的键一律拒绝 */
export const READABLE_SETTINGS = ['source.enabled', 'source.apiKey.pixabay', 'app.keyStorage'] as const

export const WRITABLE_SETTINGS = ['source.enabled', 'source.apiKey.pixabay'] as const
