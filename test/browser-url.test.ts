import { describe, expect, it } from 'vitest'
import { isHttpUrl, isLoginUrl, normalizeBrowserUrl } from '../src/main/browser/url'

describe('站内浏览地址处理', () => {
  it('只接受 http/https', () => {
    expect(isHttpUrl('https://pixabay.com/')).toBe(true)
    expect(isHttpUrl('http://example.com')).toBe(true)
    expect(isHttpUrl('file:///C:/Windows')).toBe(false)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('ms-settings:display')).toBe(false)
    expect(isHttpUrl('mailto:a@b.com')).toBe(false)
  })

  it('仅输入域名时补 https，非法输入返回 null', () => {
    expect(normalizeBrowserUrl('pixabay.com')).toBe('https://pixabay.com/')
    expect(normalizeBrowserUrl('https://pexels.com/search/?q=a')).toBe(
      'https://pexels.com/search/?q=a'
    )
    expect(normalizeBrowserUrl('file:///C:/Windows')).toBeNull()
    expect(normalizeBrowserUrl('搜索 关键词')).toBeNull()
    expect(normalizeBrowserUrl('')).toBeNull()
    expect(normalizeBrowserUrl(null)).toBeNull()
    expect(normalizeBrowserUrl('a'.repeat(2050))).toBeNull()
  })

  it('登录/账号路径可识别，普通浏览路径不受影响', () => {
    expect(isLoginUrl('https://pixabay.com/accounts/login/')).toBe(true)
    expect(isLoginUrl('https://example.com/signin')).toBe(true)
    expect(isLoginUrl('https://example.com/images/search')).toBe(false)
    expect(isLoginUrl('not a url')).toBe(false)
  })
})
