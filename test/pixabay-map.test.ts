import { describe, expect, it } from 'vitest'
import {
  buildSearchUrl,
  mapHit,
  parsePage,
  parseRateLimitRemaining,
  type PixabayHit
} from '../src/main/sources/pixabay-map'

const imageHit: PixabayHit = {
  id: 123,
  pageURL: 'https://pixabay.com/photos/mountain-123/',
  tags: 'mountain, sky, nature',
  webformatURL: 'https://cdn.example/123_640.jpg',
  largeImageURL: 'https://cdn.example/123_1280.jpg',
  imageWidth: 4000,
  imageHeight: 3000,
  imageSize: 2_048_000
}

describe('pixabay mapping', () => {
  it('builds image search urls with encoded keyword', () => {
    const url = buildSearchUrl('KEY', { keyword: 'snow mountain', type: 'image', page: 2, pageSize: 20 })
    expect(url.startsWith('https://pixabay.com/api/?')).toBe(true)
    expect(url).toContain('key=KEY')
    expect(url).toContain('q=snow+mountain')
    expect(url).toContain('page=2')
    expect(url).toContain('per_page=20')
    expect(url).toContain('image_type=photo')
  })

  it('uses the videos endpoint for video search', () => {
    const url = buildSearchUrl('KEY', { keyword: 'coffee', type: 'video', page: 1, pageSize: 20 })
    expect(url.startsWith('https://pixabay.com/api/videos/?')).toBe(true)
    expect(url).toContain('video_type=all')
  })

  it('maps an image hit without inventing missing fields', () => {
    const meta = mapHit(imageHit, 'image')
    expect(meta.sourceId).toBe('pixabay')
    expect(meta.remoteId).toBe('123')
    expect(meta.title).toBe('mountain / sky / nature')
    expect(meta.license).toBe('free')
    expect(meta.durationSec).toBeNull()
    expect(meta.sizeBytes).toBe(2_048_000)
    expect(meta.width).toBe(4000)
  })

  it('fills null instead of zero when the api omits a value', () => {
    const meta = mapHit({ id: 9, tags: 'x' }, 'image')
    expect(meta.thumbUrl).toBeNull()
    expect(meta.width).toBeNull()
    expect(meta.sizeBytes).toBeNull()
    expect(meta.pageUrl).toBeNull()
    expect(meta.title).toBe('x')
  })

  it('maps a video hit with duration and medium size', () => {
    const meta = mapHit(
      {
        id: 7,
        duration: 12.5,
        pageURL: 'https://pixabay.com/videos/x-7/',
        videos: {
          medium: { url: 'https://cdn.example/v.mp4', width: 1280, height: 720, size: 900_000 }
        }
      },
      'video'
    )
    expect(meta.type).toBe('video')
    expect(meta.durationSec).toBe(12.5)
    expect(meta.sizeBytes).toBe(900_000)
    expect(meta.width).toBe(1280)
    expect(meta.previewUrl).toBe('https://cdn.example/v.mp4')
  })

  it('computes paging from totalHits', () => {
    const query = { keyword: 'a', type: 'image' as const, page: 1, pageSize: 20 }
    const first = parsePage({ totalHits: 45, hits: [imageHit] }, query)
    expect(first.items).toHaveLength(1)
    expect(first.totalHits).toBe(45)
    expect(first.hasNext).toBe(true)

    const last = parsePage({ totalHits: 45, hits: [] }, { ...query, page: 3 })
    expect(last.hasNext).toBe(false)
  })

  it('reads rate limit headers defensively', () => {
    expect(parseRateLimitRemaining({ 'x-ratelimit-remaining': '77' })).toBe(77)
    expect(parseRateLimitRemaining({})).toBeNull()
    expect(parseRateLimitRemaining({ 'x-ratelimit-remaining': 'oops' })).toBeNull()
  })
})
