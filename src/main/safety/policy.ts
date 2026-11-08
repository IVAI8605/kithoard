import type { AssetType } from '@shared/types'
import { extFromUrl } from '../download/naming'

/**
 * 下载前拦截策略（§7.4-5）。
 * 只做「地址与元数据层面能判断的事」：扩展名、明确的可执行/脚本类型、已知过大的文件。
 * 真正的文件内容判定在下载后的魔数校验里做，两层互补。
 */

/** 按素材类型允许的扩展名；模板暂无来源，一律拒绝，避免把压缩包当模板放进来 */
const ALLOWED: Record<AssetType, readonly string[]> = {
  image: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'],
  video: ['mp4', 'webm', 'mov', 'mkv'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'],
  font: ['ttf', 'otf', 'woff', 'woff2'],
  template: []
}

/** 明确拒绝的类型：可执行、脚本、安装包、文档、压缩包（§4.4 页面下载同样口径） */
const BLOCKED = new Set([
  'exe', 'com', 'bat', 'cmd', 'msi', 'scr', 'pif', 'cpl', 'dll', 'sys',
  'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'jar', 'lnk', 'reg',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'img'
])

/** 超过这个大小先让用户确认（§7.4-5「大小上限提示」） */
export const LARGE_FILE_BYTES = 200 * 1024 * 1024

export interface UrlCheck {
  ok: boolean
  reason?: string
}

/** 检查 URL 的扩展名；没有扩展名时放行，交给下载后的魔数校验兜底 */
export function checkDownloadUrl(url: string, type: AssetType): UrlCheck {
  const ext = extFromUrl(url)
  if (!ext) return { ok: true }
  if (BLOCKED.has(ext)) return { ok: false, reason: `不允许下载 .${ext} 类型文件` }

  const allowed = ALLOWED[type]
  if (allowed.length === 0) return { ok: false, reason: '当前版本暂不支持该素材类型下载' }
  if (!allowed.includes(ext)) {
    return { ok: false, reason: `该素材类型不允许 .${ext} 扩展名` }
  }
  return { ok: true }
}

/** 大文件需要二次确认；界面批次会把它接到确认框，当前先要求调用方显式传 confirmLarge */
export function needsLargeFileConfirm(sizeBytes: number | null): boolean {
  return sizeBytes !== null && sizeBytes >= LARGE_FILE_BYTES
}
