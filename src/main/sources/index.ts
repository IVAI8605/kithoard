import { createPixabaySource } from './pixabay'
import { SourceRegistry } from './registry'

/** V0.1 只接 Pixabay；其他源在后续版本注册进来，IPC 层不需要改 */
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
  return registry
}
