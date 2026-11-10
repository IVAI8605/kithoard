import { makeError } from '@shared/errors'
import type { AssetType } from '@shared/types'
import type { SourceRegistry } from './registry'

export interface RefreshTarget {
  sourceId: string
  remoteId: string
  type: AssetType
}

/**
 * 下载前的直链续期入口（§7.11-A）。
 * 复用注册表的适配器与限流桶：不新开一套缓存或限额，避免批量下载时绕过既有约束。
 * 返回 null 表示该来源/类型不需要续期，调用方直接用库内链接。
 */
export async function refreshDownloadUrl(
  registry: SourceRegistry,
  target: RefreshTarget,
  signal: AbortSignal
): Promise<string | null> {
  const entry = registry.get(target.sourceId)
  if (!entry) return null
  if (!entry.adapter.capabilities.refreshableDownloadTypes.includes(target.type)) return null
  // 续期会真实消耗官方额度，先扣本地限额，超限时不发请求
  if (!entry.bucket.take()) throw makeError('E_RATE_LIMITED')
  const plan = await entry.adapter.resolveDownload(target.remoteId, signal)
  return plan.url
}
