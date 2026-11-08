import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MAX_THUMB_BYTES = 8 * 1024 * 1024
const KNOWN_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif'])

export function thumbNameForUrl(url: string): string {
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 40)
  return `${hash}.${extFromUrl(url)}`
}

function extFromUrl(url: string): string {
  try {
    const ext = path.extname(new URL(url).pathname).replace('.', '').toLowerCase()
    if (ext === 'jpeg') return 'jpg'
    if (KNOWN_EXT.has(ext)) return ext
  } catch {
    // 非法 URL 走默认扩展名，下载阶段会再校验
  }
  return 'jpg'
}

function extFromContentType(contentType: string | null): string | null {
  if (!contentType) return null
  if (contentType.includes('png')) return 'png'
  if (contentType.includes('webp')) return 'webp'
  if (contentType.includes('gif')) return 'gif'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg'
  return null
}

/**
 * 缩略图必须落本地再显示：卡片不直连远程图，避免图源被墙时整页空白，
 * 也避免把用户 IP 暴露给第三方 CDN。
 */
export async function cacheThumbnail(
  url: string,
  dir: string,
  signal: AbortSignal
): Promise<string | null> {
  const expected = thumbNameForUrl(url)
  const target = path.join(dir, expected)
  if (fs.existsSync(target)) return expected

  const combined = AbortSignal.any([signal, AbortSignal.timeout(12_000)])
  try {
    const response = await fetch(url, { signal: combined })
    if (!response.ok) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_THUMB_BYTES) return null

    fs.mkdirSync(dir, { recursive: true })
    const ext = extFromContentType(response.headers.get('content-type')) ?? extFromUrl(url)
    const name = ext === expected.split('.').pop() ? expected : `${expected.split('.')[0]}.${ext}`
    const finalPath = path.join(dir, name)
    const tempPath = `${finalPath}.tmp`
    fs.writeFileSync(tempPath, buffer)
    fs.renameSync(tempPath, finalPath)
    return name
  } catch {
    // 单张图失败只让卡片显示占位，不拖垮整页搜索结果
    return null
  }
}

/** 限并发 4，避免 20 张卡同时打图源触发限流 */
export async function cacheThumbnails(
  urls: Array<string | null>,
  dir: string,
  signal: AbortSignal,
  limit = 4
): Promise<Array<string | null>> {
  const result: Array<string | null> = new Array<string | null>(urls.length).fill(null)
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (cursor < urls.length) {
      const index = cursor
      cursor += 1
      const url = urls[index]
      if (url) result[index] = await cacheThumbnail(url, dir, signal)
    }
  }

  const workers = Array.from({ length: Math.min(limit, Math.max(urls.length, 1)) }, () => worker())
  await Promise.all(workers)
  return result
}
