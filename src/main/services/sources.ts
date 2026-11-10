import type { SourceInfo } from '@shared/types'
import { getEnabledSources, hasApiKey, hasStoredApiKey } from '../settings'
import type { SourceRegistry } from '../sources/registry'

export interface SourceService {
  /** 源列表同时承载"能不能干活"的判断依据：就绪状态、是否缺 Key、剩余额度 */
  list(): SourceInfo[]
}

export function createSourceService(deps: { registry: SourceRegistry }): SourceService {
  return {
    list() {
      const enabled = getEnabledSources()
      return deps.registry.all().map(({ adapter, bucket }) => ({
        id: adapter.id,
        name: adapter.name,
        enabled: enabled.includes(adapter.id),
        ready: adapter.isReady(),
        requiresApiKey: adapter.capabilities.requiresApiKey,
        hasApiKey: adapter.capabilities.requiresApiKey ? hasApiKey(adapter.id) : true,
        keyUndecryptable: adapter.capabilities.requiresApiKey
          ? hasStoredApiKey(adapter.id) && !hasApiKey(adapter.id)
          : false,
        rateLimitRemaining: bucket.remaining
      }))
    }
  }
}
