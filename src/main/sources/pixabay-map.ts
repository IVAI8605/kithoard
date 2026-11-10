import type { AssetMeta, SearchQuery } from '@shared/types'

export const PIXABAY_ID = 'pixabay'
export const PIXABAY_NAME = 'Pixabay'
export const PIXABAY_BASE = 'https://pixabay.com/api/'

export interface PixabayVideoVariant {
  url: string
  width: number
  height: number
  size: number
  thumbnail?: string
}

export interface PixabayHit {
  id: number
  pageURL?: string
  tags?: string
  previewURL?: string
  webformatURL?: string
  largeImageURL?: string
  imageWidth?: number
  imageHeight?: number
  imageSize?: number
  duration?: number
  videos?: Record<string, PixabayVideoVariant | undefined>
}

export interface PixabayPayload {
  total?: number
  totalHits?: number
  hits?: PixabayHit[]
}

export function buildSearchUrl(apiKey: string, query: SearchQuery): string {
  const base = query.type === 'video' ? `${PIXABAY_BASE}videos/` : PIXABAY_BASE
  const params = new URLSearchParams({
    key: apiKey,
    q: query.keyword,
    safesearch: 'true',
    page: String(query.page),
    per_page: String(query.pageSize)
  })
  if (query.type === 'video') params.set('video_type', 'all')
  else params.set('image_type', 'photo')
  return `${base}?${params.toString()}`
}

/**
 * 按 id 取单条：搜索结果里的图片直链是短时效签名链接，过期后只能靠这个接口拿新的。
 * 只用于图片；视频走 cdn.pixabay.com 的永久链接，不需要续期。
 */
export function buildByIdUrl(apiKey: string, remoteId: string): string {
  const params = new URLSearchParams({ key: apiKey, id: remoteId })
  return `${PIXABAY_BASE}?${params.toString()}`
}

/** 单条查询只取第一条命中；素材可能已被删除，此时返回 null 让调用方回退 */
export function parseSingleHit(payload: PixabayPayload): PixabayHit | null {
  return payload.hits?.[0] ?? null
}

function splitTags(tags: string | undefined): string[] {
  if (!tags) return []
  return tags
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

function titleFromTags(tags: string[]): string {
  // 素材标题由标签派生，取前三段；没有标签时给中性占位，不编造名称
  return tags.slice(0, 3).join(' / ') || '未命名素材'
}

export function mapHit(hit: PixabayHit, type: 'image' | 'video'): AssetMeta {
  const tags = splitTags(hit.tags)
  const medium = hit.videos?.medium
  const isVideo = type === 'video'
  return {
    sourceId: PIXABAY_ID,
    remoteId: String(hit.id),
    type,
    title: titleFromTags(tags),
    thumbUrl: isVideo ? (medium?.thumbnail ?? null) : (hit.webformatURL ?? null),
    previewUrl: isVideo ? (medium?.url ?? null) : (hit.largeImageURL ?? null),
    pageUrl: hit.pageURL ?? null,
    width: isVideo ? (medium?.width ?? null) : (hit.imageWidth ?? null),
    height: isVideo ? (medium?.height ?? null) : (hit.imageHeight ?? null),
    durationSec: isVideo ? (hit.duration ?? null) : null,
    sizeBytes: isVideo ? (medium?.size ?? null) : (hit.imageSize ?? null),
    // Pixabay 返回的素材均为 Pixabay Content License，接口没有付费字段
    license: 'free',
    tags
  }
}

export function parsePage(payload: PixabayPayload, query: SearchQuery): {
  items: AssetMeta[]
  totalHits: number
  hasNext: boolean
} {
  const items = (payload.hits ?? []).map((hit) => mapHit(hit, query.type))
  const totalHits = payload.totalHits ?? 0
  return {
    items,
    totalHits,
    hasNext: query.page * query.pageSize < totalHits
  }
}

export function parseRateLimitRemaining(headers: Record<string, string>): number | null {
  const raw = headers['x-ratelimit-remaining']
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : null
}
