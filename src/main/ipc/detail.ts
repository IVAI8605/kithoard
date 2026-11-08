import { makeError } from '@shared/errors'
import type { AssetDetail, AssetMeta, AssetType, LicenseState } from '@shared/types'
import { getDb } from '../db'
import type { SourceRegistry } from '../sources/registry'
import { cacheThumbnail } from '../sources/thumbs'

interface AssetRow {
  id: number
  source_id: string
  remote_id: string
  type: AssetType
  title: string
  thumb_url: string | null
  preview_url: string | null
  page_url: string | null
  width: number | null
  height: number | null
  duration_sec: number | null
  size_bytes: number | null
  license: LicenseState
  tags: string | null
  fetched_at: number
}

function parseTags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}

function toMeta(row: AssetRow, tags: string[]): AssetMeta {
  return {
    sourceId: row.source_id,
    remoteId: row.remote_id,
    type: row.type,
    title: row.title,
    thumbUrl: row.thumb_url,
    previewUrl: row.preview_url,
    pageUrl: row.page_url,
    width: row.width,
    height: row.height,
    durationSec: row.duration_sec,
    sizeBytes: row.size_bytes,
    license: row.license,
    tags
  }
}

export function createDetailHandler(deps: {
  registry: SourceRegistry
  thumbsDir: string
}): (raw: unknown) => Promise<AssetDetail> {
  return async (raw) => {
    const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    const id = record.assetId
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      throw makeError('E_INVALID_ARG', 'assetId')
    }

    const row = getDb().prepare('SELECT * FROM assets WHERE id = ?').get(id) as
      | AssetRow
      | undefined
    if (!row) throw makeError('E_INVALID_ARG', 'asset not found')

    const adapter = deps.registry.get(row.source_id)?.adapter
    const tags = parseTags(row.tags)
    const meta = toMeta(row, tags)
    const thumbName = row.thumb_url
      ? await cacheThumbnail(row.thumb_url, deps.thumbsDir, AbortSignal.timeout(15_000))
      : null

    return {
      id: row.id,
      sourceId: row.source_id,
      sourceName: adapter?.name ?? row.source_id,
      remoteId: row.remote_id,
      type: row.type,
      title: row.title,
      thumbName,
      previewUrl: row.preview_url,
      pageUrl: row.page_url,
      width: row.width,
      height: row.height,
      durationSec: row.duration_sec,
      sizeBytes: row.size_bytes,
      license: row.license,
      tags,
      attribution: adapter?.attributionOf(meta) ?? null,
      fetchedAt: row.fetched_at
    }
  }
}
