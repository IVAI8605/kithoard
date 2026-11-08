import { protocol, net } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const THUMB_SCHEME = 'kithoard-thumb'

// 只放行「40 位哈希 + 已知图片扩展名」，杜绝 ../ 穿越读任意文件
const SAFE_NAME = /^[a-f0-9]{40}\.(jpg|png|webp|gif)$/

export function registerThumbProtocol(thumbsDir: string): void {
  protocol.handle(THUMB_SCHEME, (request) => {
    const url = new URL(request.url)
    const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    if (!SAFE_NAME.test(name)) {
      return new Response('Not Found', { status: 404 })
    }
    return net.fetch(pathToFileURL(path.join(thumbsDir, name)).toString())
  })
}
