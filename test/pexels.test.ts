import { describe, expect, it } from 'vitest'
import { buildSearchUrl, pickVideoFile, PEXELS_ID, PEXELS_NAME } from '../src/main/sources/pexels'

describe('Pexels 适配器', () => {
  it('来源标识与名称固定', () => {
    expect(PEXELS_ID).toBe('pexels')
    expect(PEXELS_NAME).toBe('Pexels')
  })

  it('图片与视频走不同端点，查询参数完整', () => {
    const query = { keyword: 'mountain lake', type: 'image' as const, page: 2, pageSize: 20 }
    const imageUrl = buildSearchUrl(false, query)
    expect(imageUrl.startsWith('https://api.pexels.com/v1/search?')).toBe(true)
    expect(imageUrl).toContain('query=mountain+lake')
    expect(imageUrl).toContain('page=2')
    expect(imageUrl).toContain('per_page=20')

    const videoUrl = buildSearchUrl(true, query)
    expect(videoUrl.startsWith('https://api.pexels.com/videos/search?')).toBe(true)
  })

  it('视频文件优先 1280–1920 的 mp4', () => {
    const files = [
      { id: 1, quality: 'sd', file_type: 'video/mp4', width: 640, height: 360, link: 'a' },
      { id: 2, quality: 'hd', file_type: 'video/mp4', width: 1920, height: 1080, link: 'b' },
      { id: 3, quality: 'uhd', file_type: 'video/mp4', width: 3840, height: 2160, link: 'c' }
    ]
    expect(pickVideoFile(files)?.link).toBe('b')
  })

  it('没有合适清晰度时退回第一个 mp4，跳过非 mp4', () => {
    const files = [
      { id: 1, quality: 'sd', file_type: 'video/webm', width: 640, height: 360, link: 'webm' },
      { id: 2, quality: 'sd', file_type: 'video/mp4', width: 640, height: 360, link: 'mp4' }
    ]
    expect(pickVideoFile(files)?.link).toBe('mp4')
    expect(pickVideoFile([])).toBeNull()
  })
})
