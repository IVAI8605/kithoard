import type { AssetType, LicenseState, SearchResultItem } from '@shared/types'
import { getDb } from '../db'
import type { SourceRegistry } from '../sources/registry'
import { cacheThumbnails } from '../sources/thumbs'

/** 首页「最近浏览」展示的条数上限；再大就变成第二个搜索页，没必要 */
const DEFAULT_LIMIT = 12
const MAX_LIMIT = 50

interface RecentRow {
  id: number
  source_id: string
  remote_id: string
  type: AssetType
  title: string
  thumb_url: string | null
  page_url: string | null
  width: number | null
  height: number | null
  duration_sec: number | null
  size_bytes: number | null
  license: LicenseState
}

export interface RecentService {
  list(raw: unknown): Promise<SearchResultItem[]>
}

/**
 * 只从本地 assets 表读，不触发任何网络请求。
 * 这是「关软件重开后还能打开同一条素材」的实现基础：数据早已落库，与本次是否联网无关。
 */
export function createRecentService(deps: {
  registry: SourceRegistry
  thumbsDir: string
}): RecentService {
  return {
    async list(raw) {
      const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
      const requested = record.limit
      const limit =
        typeof requested === 'number' && Number.isInteger(requested) && requested > 0
          ? Math.min(requested, MAX_LIMIT)
          : DEFAULT_LIMIT

      const rows = getDb()
        .prepare(
          `SELECT id, source_id, remote_id, type, title, thumb_url, page_url,
                  width, height, duration_sec, size_bytes, license
             FROM assets
            ORDER BY fetched_at DESC, id DESC
            LIMIT ?`
        )
        .all(limit) as RecentRow[]

      // 缩略图可能已被缓存清理删掉，走同一个缓存函数顺带补齐；离线时失败也不影响记录本身可见
      const thumbNames = await cacheThumbnails(
        rows.map((row) => row.thumb_url),
        deps.thumbsDir,
        AbortSignal.timeout(15_000)
      )

      return rows.map((row, index) => ({
        id: row.id,
        sourceId: row.source_id,
        sourceName: deps.registry.get(row.source_id)?.adapter.name ?? row.source_id,
        remoteId: row.remote_id,
        type: row.type,
        title: row.title,
        thumbName: thumbNames[index] ?? null,
        pageUrl: row.page_url,
        width: row.width,
        height: row.height,
        durationSec: row.duration_sec,
        sizeBytes: row.size_bytes,
        license: row.license
      }))
    }
  }
}
