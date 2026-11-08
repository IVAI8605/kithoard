import { makeError } from '@shared/errors'
import type { AssetMeta, SearchPageResult, SearchResultItem } from '@shared/types'
import { getDb } from '../db'
import { log } from '../log'
import { getEnabledSources } from '../settings'
import type { SourceRegistry } from '../sources/registry'
import { cacheThumbnails } from '../sources/thumbs'
import { validateSearchQuery } from './guard'

const UPSERT_ASSET = `
INSERT INTO assets (
  source_id, remote_id, type, title, thumb_url, preview_url, page_url,
  width, height, duration_sec, size_bytes, license, tags, fetched_at
) VALUES (
  @sourceId, @remoteId, @type, @title, @thumbUrl, @previewUrl, @pageUrl,
  @width, @height, @durationSec, @sizeBytes, @license, @tags, @fetchedAt
)
ON CONFLICT(source_id, remote_id) DO UPDATE SET
  title = excluded.title,
  thumb_url = excluded.thumb_url,
  preview_url = excluded.preview_url,
  page_url = excluded.page_url,
  width = excluded.width,
  height = excluded.height,
  duration_sec = excluded.duration_sec,
  size_bytes = excluded.size_bytes,
  license = excluded.license,
  tags = excluded.tags,
  fetched_at = excluded.fetched_at
RETURNING id
`

interface UpsertedRow {
  id: number
  meta: AssetMeta
  index: number
}

export function createSearchHandler(deps: {
  registry: SourceRegistry
  thumbsDir: string
}): (raw: unknown) => Promise<SearchPageResult> {
  return async (raw) => {
    const query = validateSearchQuery(raw)
    const enabled = getEnabledSources()
    const entry = deps.registry
      .all()
      .find(
        (candidate) =>
          enabled.includes(candidate.adapter.id) &&
          candidate.adapter.capabilities.types.includes(query.type)
      )

    if (!entry) throw makeError('E_UNSUPPORTED', 'no enabled source for this type')
    if (!entry.adapter.isReady()) throw makeError('E_AUTH_REQUIRED')

    // 本地限流先扣额度，超限时不发请求，直接给可重试提示
    if (!entry.bucket.take()) throw makeError('E_RATE_LIMITED')

    const page = await entry.adapter.search(query, AbortSignal.timeout(20_000))
    log.info(
      `search source=${entry.adapter.id} type=${query.type} page=${query.page} hits=${page.items.length}`
    )

    const rows = persistAssets(page.items)
    const thumbNames = await cacheThumbnails(
      page.items.map((item) => item.thumbUrl),
      deps.thumbsDir,
      AbortSignal.timeout(25_000)
    )

    const items: SearchResultItem[] = rows.map((row) => ({
      id: row.id,
      sourceId: entry.adapter.id,
      sourceName: entry.adapter.name,
      remoteId: row.meta.remoteId,
      type: row.meta.type,
      title: row.meta.title,
      thumbName: thumbNames[row.index] ?? null,
      pageUrl: row.meta.pageUrl,
      width: row.meta.width,
      height: row.meta.height,
      durationSec: row.meta.durationSec,
      sizeBytes: row.meta.sizeBytes,
      license: row.meta.license
    }))

    return {
      items,
      page: page.page,
      pageSize: page.pageSize,
      totalHits: page.totalHits,
      hasNext: page.hasNext,
      rateLimitRemaining: page.rateLimitRemaining,
      sourceNotice: entry.adapter.capabilities.requiresSourceNotice
        ? {
            text: 'Powered by Pixabay',
            url: 'https://pixabay.com/?utm_source=kithoard&utm_medium=referral'
          }
        : null
    }
  }
}

/** 搜索结果必须先落 assets 表，详情页与「重启后仍可打开」都依赖它 */
function persistAssets(items: AssetMeta[]): UpsertedRow[] {
  const db = getDb()
  const upsert = db.prepare(UPSERT_ASSET)
  const write = db.transaction((list: AssetMeta[]): UpsertedRow[] =>
    list.map((meta, index) => {
      const row = upsert.get({
        sourceId: meta.sourceId,
        remoteId: meta.remoteId,
        type: meta.type,
        title: meta.title,
        thumbUrl: meta.thumbUrl,
        previewUrl: meta.previewUrl,
        pageUrl: meta.pageUrl,
        width: meta.width,
        height: meta.height,
        durationSec: meta.durationSec,
        sizeBytes: meta.sizeBytes,
        license: meta.license,
        tags: JSON.stringify(meta.tags),
        fetchedAt: Date.now()
      }) as { id: number }
      return { id: row.id, meta, index }
    })
  )
  return write(items)
}
