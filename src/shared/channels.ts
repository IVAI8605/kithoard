/** 通道名集中在此，主进程与 preload 共用，避免字符串漂移 */
export const CHANNELS = {
  sourceList: 'source:list',
  searchRun: 'search:run',
  assetDetail: 'asset:detail',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  // 规划表里没有复制通道；V0.1 需要「复制来源链接」，用主进程剪贴板避免依赖页面安全上下文
  copyText: 'app:copyText'
} as const

/** 渲染层可读的设置键白名单；不在表内的键一律拒绝 */
export const READABLE_SETTINGS = ['source.enabled', 'source.apiKey.pixabay', 'app.keyStorage'] as const

export const WRITABLE_SETTINGS = ['source.enabled', 'source.apiKey.pixabay'] as const
