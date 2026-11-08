/** 登录/账号路径直接转系统浏览器，应用内不出现密码输入被提交的场面（§4.4） */
const LOGIN_PATTERN = /\/(login|signin|sign-in|auth|account|password|checkout)(\/|$|\?)/i

export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * 用户只输入域名时补 https；不把搜索词当网址，避免变成隐形搜索引擎。
 * 只接受 http/https，file/javascript/ms-* 等协议一律拒绝。
 */
export function normalizeBrowserUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || value.length > 2048) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`
  try {
    const parsed = new URL(withScheme)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

export function isLoginUrl(url: string): boolean {
  try {
    return LOGIN_PATTERN.test(new URL(url).pathname)
  } catch {
    return false
  }
}
