import { describe, expect, it } from 'vitest'
import { isAppError } from '../src/shared/errors'
import { refreshDownloadUrl } from '../src/main/sources/refresh'
import { SourceRegistry } from '../src/main/sources/registry'
import type { AssetSource, DownloadPlan, SearchPage, SourceCapabilities } from '../src/main/sources/types'
import type { AssetMeta } from '../src/shared/types'

function stubSource(overrides: Partial<AssetSource> & { id: string }): AssetSource {
  const { capabilities, ...rest } = overrides
  const merged: SourceCapabilities = {
    types: ['image', 'video'],
    requiresApiKey: true,
    attributionRequired: false,
    maxPageSize: 20,
    requiresSourceNotice: false,
    refreshableDownloadTypes: [],
    ...capabilities
  }
  return {
    name: overrides.id,
    isReady: () => true,
    search: async (): Promise<SearchPage> => {
      throw new Error('not used')
    },
    getDetail: async (): Promise<AssetMeta> => {
      throw new Error('not used')
    },
    resolveDownload: async (): Promise<DownloadPlan> => {
      throw new Error('not used')
    },
    attributionOf: () => null,
    ...rest,
    capabilities: merged
  }
}

function registryWith(source: AssetSource, perMinute: number): SourceRegistry {
  const registry = new SourceRegistry()
  registry.register(source, perMinute)
  return registry
}

const signal = AbortSignal.timeout(1000)

describe('直链续期', () => {
  it('按 id 取到新鲜链接，并消耗一次本地限额', async () => {
    let called = 0
    const source = stubSource({
      id: 'pixabay',
      capabilities: { refreshableDownloadTypes: ['image'] },
      resolveDownload: async (remoteId) => {
        called += 1
        return { url: `https://cdn.example/${remoteId}_fresh.jpg`, fileName: '', headers: {} }
      }
    })
    const registry = registryWith(source, 80)

    const url = await refreshDownloadUrl(
      registry,
      { sourceId: 'pixabay', remoteId: '123', type: 'image' },
      signal
    )

    expect(url).toBe('https://cdn.example/123_fresh.jpg')
    expect(called).toBe(1)
  })

  it('直链不过期的类型直接返回 null，不发请求也不占额度', async () => {
    let called = 0
    const source = stubSource({
      id: 'pixabay',
      capabilities: { refreshableDownloadTypes: ['image'] },
      resolveDownload: async () => {
        called += 1
        return { url: 'https://cdn.example/fresh.jpg', fileName: '', headers: {} }
      }
    })
    const registry = registryWith(source, 80)

    const url = await refreshDownloadUrl(
      registry,
      { sourceId: 'pixabay', remoteId: '123', type: 'video' },
      signal
    )

    expect(url).toBeNull()
    expect(called).toBe(0)
  })

  it('未知来源返回 null，不当成失败', async () => {
    const registry = registryWith(stubSource({ id: 'pixabay' }), 80)

    const url = await refreshDownloadUrl(
      registry,
      { sourceId: 'unknown', remoteId: '1', type: 'image' },
      signal
    )

    expect(url).toBeNull()
  })

  it('额度用尽时抛 E_RATE_LIMITED，让引擎回退库内链接', async () => {
    const source = stubSource({
      id: 'pixabay',
      capabilities: { refreshableDownloadTypes: ['image'] },
      resolveDownload: async () => ({ url: 'https://cdn.example/fresh.jpg', fileName: '', headers: {} })
    })
    const registry = registryWith(source, 1)
    const target = { sourceId: 'pixabay', remoteId: '1', type: 'image' }

    await refreshDownloadUrl(registry, target, signal)
    try {
      await refreshDownloadUrl(registry, target, signal)
      throw new Error('应当抛错')
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('E_RATE_LIMITED')
    }
  })
})
