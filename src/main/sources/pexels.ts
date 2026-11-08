import { makeError } from '@shared/errors'
import type { AssetMeta, SearchQuery } from '@shared/types'
import { fetchJson } from './http'
import type { AssetSource, SearchPage } from './types'

export const PEXELS_ID = 'pexels'
export const PEXELS_NAME = 'Pexels'

const API_ROOT = 'https://api.pexels.com/v1'
const VIDEO_ROOT = 'https://api.pexels.com/videos'

interface PexelsPhoto {
  id: number
  width: number
  height: number
  url: string
  photographer: string
  alt: string | null
  src: { original: string; large2x: string; large: string; medium: string }
}

interface PexelsVideoFile {
  id: number
  quality: string
  file_type: string
  width: number | null
  height: number | null
  link: string
}

interface PexelsVideo {
  id: number
  width: number
  height: number
  url: string
  image: string
  duration: number
  user: { name: string; url: string }
  video_files: PexelsVideoFile[]
}

interface PhotoPayload {
  page: number
  per_page: number
  total_results: number
  photos: PexelsPhoto[]
}

interface VideoPayload {
  page: number
  per_page: number
  total_results: number
  videos: PexelsVideo[]
}

/**
 * Pexels 与 Pixabay 的差异集中在三处：
 * 1. Key 走 Authorization 头，不拼查询串；
 * 2. 图片与视频是两套端点，字段结构完全不同；
 * 3. 许可证统一免费，但页面不强制署名，仍保留来源文字标识。
 */
export function createPexelsSource(deps: {
  getApiKey: () => string
  cacheDir: string
}): AssetSource {
  const apiKey = (): string => deps.getApiKey()

  return {
    id: PEXELS_ID,
    name: PEXELS_NAME,
    capabilities: {
      types: ['image', 'video'],
      requiresApiKey: true,
      attributionRequired: false,
      maxPageSize: 20,
      requiresSourceNotice: false
    },
    isReady: () => apiKey().length > 0,
    async search(query: SearchQuery, signal: AbortSignal): Promise<SearchPage> {
      const key = apiKey()
      if (!key) throw makeError('E_AUTH_REQUIRED')
      const isVideo = query.type === 'video'
      const url = buildSearchUrl(isVideo, query)
      const result = await fetchJson<PhotoPayload | VideoPayload>(url, {
        signal,
        cacheDir: deps.cacheDir,
        timeoutMs: 12_000,
        headers: { Authorization: key }
      })

      const items = isVideo
        ? (result.data as VideoPayload).videos.map(toVideoMeta)
        : (result.data as PhotoPayload).photos.map(toPhotoMeta)
      const totalHits = (result.data as PhotoPayload).total_results ?? 0
      const perPage = (result.data as PhotoPayload).per_page ?? query.pageSize

      return {
        items,
        page: query.page,
        pageSize: query.pageSize,
        totalHits,
        hasNext: query.page * perPage < totalHits,
        rateLimitRemaining: null
      }
    },
    async getDetail(): Promise<never> {
      // 详情一律读本地 assets 表，与 Pixabay 保持一致，避免详情页多一次网络请求
      throw makeError('E_UNSUPPORTED', 'pexels detail is served from local db')
    },
    async resolveDownload(): Promise<never> {
      // 下载地址在搜索时已写入 assets.preview_url，这里不再单独解析
      throw makeError('E_UNSUPPORTED', 'download url is stored on asset')
    },
    attributionOf(meta) {
      if (!meta.pageUrl) return null
      const label = meta.type === 'video' ? '视频来自 Pexels' : '图片来自 Pexels'
      return { text: label, url: meta.pageUrl }
    }
  }
}

export function buildSearchUrl(isVideo: boolean, query: SearchQuery): string {
  const base = isVideo ? `${VIDEO_ROOT}/search` : `${API_ROOT}/search`
  const params = new URLSearchParams({
    query: query.keyword,
    page: String(query.page),
    per_page: String(query.pageSize)
  })
  return `${base}?${params.toString()}`
}

function toPhotoMeta(photo: PexelsPhoto): AssetMeta {
  return {
    sourceId: PEXELS_ID,
    remoteId: String(photo.id),
    type: 'image',
    title: photo.alt?.trim() || `Pexels 图片 ${photo.id}`,
    thumbUrl: photo.src.medium,
    // 原图作为下载地址；列表页不预加载它
    previewUrl: photo.src.original,
    pageUrl: photo.url,
    width: photo.width,
    height: photo.height,
    durationSec: null,
    sizeBytes: null,
    license: 'free',
    tags: []
  }
}

function toVideoMeta(video: PexelsVideo): AssetMeta {
  const file = pickVideoFile(video.video_files)
  return {
    sourceId: PEXELS_ID,
    remoteId: String(video.id),
    type: 'video',
    title: `Pexels 视频 ${video.id}`,
    thumbUrl: video.image,
    previewUrl: file?.link ?? null,
    pageUrl: video.url,
    width: video.width,
    height: video.height,
    durationSec: video.duration,
    sizeBytes: null,
    license: 'free',
    tags: []
  }
}

/**
 * 优先 720p 左右的 mp4：原片可能上百 MB，而 1080p 对剪辑预览足够。
 * 找不到合适项时退回第一个 mp4，避免有些素材只有单一清晰度时下载不了。
 */
export function pickVideoFile(files: PexelsVideoFile[]): PexelsVideoFile | null {
  const mp4 = files.filter((file) => file.file_type === 'video/mp4' && file.link)
  const preferred = mp4.find(
    (file) => (file.width ?? 0) >= 1280 && (file.width ?? 0) <= 1920
  )
  return preferred ?? mp4[0] ?? null
}
