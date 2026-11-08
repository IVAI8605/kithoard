/**
 * 日志脱敏：URL 查询串整体替换，Windows 用户目录里的用户名替换为 %USER%。
 * 单独成模块是为了能被单测覆盖，且不依赖 Electron。
 */
export function redactUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return '<invalid-url>'
  }
  const query = parsed.search ? '?<redacted>' : ''
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${query}`
}

const WINDOWS_USER_HOME = /([A-Za-z]:\\Users\\)[^\\/]+/gi
const POSIX_USER_HOME = /(\/(?:home|Users)\/)[^/]+/gi

export function redactText(text: string): string {
  return text.replace(WINDOWS_USER_HOME, '$1%USER%').replace(POSIX_USER_HOME, '$1%USER%')
}

export function redactLine(line: string): string {
  const urlPattern = /https?:\/\/[^\s"')]+/g
  return redactText(line.replace(urlPattern, (match) => redactUrl(match)))
}
