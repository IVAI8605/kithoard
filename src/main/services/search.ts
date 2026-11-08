import { isAppError, makeError } from '@shared/errors'
import type {
  AssetMeta,
  GroupedSearchResult,
  SearchPageResult,
  SearchQuery,
  SearchResultItem
} from '@shared/types'
import { getDb } from '../db'
import { log } from '../log'
import { getEnabledSources } from '../settings'
import type { RegisteredSource, SourceRegistry } from '../sources/registry'
import { cacheThumbnails } from '../sources/thumbs'
import { createSeenTracker } from './seen'
import { validateSearchQuery } from './validate'

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

export interface SearchService {
  /** 入参未经校验即传入：校验属于 service 的一部分，界面与未来的 agent 网关共用同一份 */
  search(raw: unknown): Promise<SearchPageResult>
  /** 按启用源分组搜索；单源失败只影响该组，不拖垮其他源 */
  searchGrouped(raw: unknown): Promise<GroupedSearchResult>
  /** 只搜索指定源，用于组内翻页 */
  searchSource(raw: unknown): Promise<SearchPageResult>
}

export function createSearchService(deps: {
  registry: SourceRegistry
  thumbsDir: string
}): SearchService {
  // 去重记录按「源 + 类型 + 关键词」隔离，避免不同源的同名 remoteId 互相顶掉
  const seen = createSeenTracker()

  async function runOne(
    entry: RegisteredSource,
    query: SearchQuery
  ): Promise<SearchPageResult> {
    if (!entry.adapter.isReady()) throw makeError('E_AUTH_REQUIRED')
    // 本地限流先扣额度，超限时不发请求，直接给可重试提示
    if (!entry.bucket.take()) throw makeError('E_RATE_LIMITED')

    const page = await entry.adapter.search(query, AbortSignal.timeout(20_000))
    log.info(
      `search source=${entry.adapter.id} type=${query.type} page=${query.page} hits=${page.items.length}`
    )

    // 先把相邻页的重复命中挡掉，再落库与取缩略图，避免为同一张图重复下载
    const kept = seen.accept(
      `${entry.adapter.id}:${query.type}:${query.keyword}`,
      query.page,
      page.items.map((item) => item.remoteId)
    )
    const visible = page.items.filter((item) => kept.has(item.remoteId))
    if (visible.length !== page.items.length) {
      log.info(`search dedupe dropped=${page.items.length - visible.length}`)
    }

    const rows = persistAssets(visible)
    const thumbNames = await cacheThumbnails(
      visible.map((item) => item.thumbUrl),
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

  function enabledEntries(query: SearchQuery): RegisteredSource[] {
    const enabled = getEnabledSources()
    return deps.registry
      .all()
      .filter(
        (candidate) =>
          enabled.includes(candidate.adapter.id) &&
          candidate.adapter.capabilities.types.includes(query.type)
      )
  }

  return {
    async search(raw) {
      const query = validateSearchQuery(raw)
      const entry = enabledEntries(query)[0]
      if (!entry) throw makeError('E_UNSUPPORTED', 'no enabled source for this type')
      return runOne(entry, query)
    },

    async searchGrouped(raw) {
      const query = validateSearchQuery(raw)
      const entries = enabledEntries(query)
      if (entries.length === 0) throw makeError('E_UNSUPPORTED', 'no enabled source for this type')

      // 各源并行请求：一个源超时或限额用完，其他源仍要能出结果
      const groups = await Promise.all(
        entries.map(async (entry) => {
          try {
            const page = await runOne(entry, query)
            return {
              sourceId: entry.adapter.id,
              sourceName: entry.adapter.name,
              ...page,
              error: null
            }
          } catch (error) {
            const appError = isAppError(error)
              ? error
              : makeError('E_UNKNOWN', error instanceof Error ? error.message : undefined)
            log.warn(`search grouped source=${entry.adapter.id} failed code=${appError.code}`)
            return {
              sourceId: entry.adapter.id,
              sourceName: entry.adapter.name,
              items: [],
              page: query.page,
              pageSize: query.pageSize,
              totalHits: 0,
              hasNext: false,
              rateLimitRemaining: null,
              sourceNotice: null,
              error: appError
            }
          }
        })
      )
      return { groups }
    },

    async searchSource(raw) {
      const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
      const sourceId = record.sourceId
      if (typeof sourceId !== 'string' || !sourceId) throw makeError('E_INVALID_ARG', 'sourceId')
      const query = validateSearchQuery(raw)
      const entry = deps.registry.get(sourceId)
      if (!entry) throw makeError('E_INVALID_ARG', 'sourceId')
      if (!getEnabledSources().includes(sourceId)) throw makeError('E_UNSUPPORTED', 'source disabled')
      if (!entry.adapter.capabilities.types.includes(query.type)) {
        throw makeError('E_UNSUPPORTED', 'source does not support this type')
      }
      return runOne(entry, query)
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
