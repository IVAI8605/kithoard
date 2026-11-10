import { createPexelsSource } from './pexels'
import { createPixabaySource } from './pixabay'
import { refreshDownloadUrl } from './refresh'
import { SourceRegistry } from './registry'

export { refreshDownloadUrl }

/** V0.3 起接入 Pexels；新增源只需在这里注册，IPC 与界面按 enabled 列表自动跟随 */
export function createSourceRegistry(deps: {
  getApiKey: (sourceId: string) => string
  cacheDir: string
}): SourceRegistry {
  const registry = new SourceRegistry()
  const pixabay = createPixabaySource({
    getApiKey: () => deps.getApiKey('pixabay'),
    cacheDir: deps.cacheDir
  })
  // 官方限额 100 次/分钟，本地压到 80，给缩略图请求留余量
  registry.register(pixabay, 80)

  const pexels = createPexelsSource({
    getApiKey: () => deps.getApiKey('pexels'),
    cacheDir: deps.cacheDir
  })
  // 免费额度 200 次/小时，本地按 3 次/分钟保守限流
  registry.register(pexels, 3)

  return registry
}
