import type { AssetType, LicenseState } from '@shared/types'

export function typeLabel(type: AssetType): string {
  switch (type) {
    case 'image':
      return '图片'
    case 'video':
      return '视频'
    case 'audio':
      return '音频'
    case 'font':
      return '字体'
    case 'template':
      return '模板'
    default:
      return '素材'
  }
}

export function licenseLabel(license: LicenseState): string {
  if (license === 'free') return '免费'
  if (license === 'paid') return '需付费或授权'
  return '授权状态不明'
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '未提供'
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

export function formatSize(bytes: number | null): string {
  // 接口没给大小就显示「大小未知」，不用 0 冒充
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return '大小未知'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatResolution(width: number | null, height: number | null): string {
  if (!width || !height) return '未提供'
  return `${width} × ${height}`
}

export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '未知'
  return date.toLocaleString('zh-CN', { hour12: false })
}

/** 缩略图通过主进程的 kithoard-thumb 协议读取，渲染层不直接碰 file:// */
export function thumbSrc(name: string | null): string | null {
  return name ? `kithoard-thumb://local/${name}` : null
}
