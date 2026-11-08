import type { AssetType } from '@shared/types'

/**
 * 下载后魔数校验（§7.4-6）。
 * 只读文件头，不加载整个文件；判定依据是「实际内容」而不是扩展名，
 * 因此能把 `cat.jpg` 其实是 MZ 可执行文件这类伪装识别出来。
 */

export type FileKind =
  | 'jpeg' | 'png' | 'gif' | 'webp' | 'bmp' | 'avif' | 'heif'
  | 'mp4' | 'mov' | 'webm' | 'matroska'
  | 'mp3' | 'aac' | 'wav' | 'ogg' | 'flac' | 'm4a'
  | 'ttf' | 'otf' | 'woff' | 'woff2'
  | 'exe' | 'elf' | 'macho' | 'pdf' | 'zip' | 'rar' | '7z'
  | 'unknown'

export type FileFamily = AssetType | 'executable' | 'archive' | 'pdf' | 'unknown'

const FAMILY_LABEL: Record<FileFamily, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  font: '字体',
  template: '模板',
  executable: '可执行程序',
  archive: '压缩包',
  pdf: 'PDF 文档',
  unknown: '未知格式'
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length))
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  return signature.every((value, index) => bytes[index] === value)
}

/** 依据文件头判断真实类型；样本不足或识别不了时返回 unknown，不靠扩展名猜 */
export function sniffKind(head: Uint8Array): FileKind {
  // 至少要有两个字节才能判断 MZ；更短的样本只可能是损坏文件
  if (head.length < 2) return 'unknown'

  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return 'png'
  if (ascii(head, 0, 4) === 'GIF8') return 'gif'
  if (ascii(head, 0, 4) === 'RIFF' && head.length >= 12) {
    const brand = ascii(head, 8, 4)
    if (brand === 'WEBP') return 'webp'
    if (brand === 'WAVE') return 'wav'
  }
  if (ascii(head, 0, 2) === 'BM') return 'bmp'
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'matroska'
  if (ascii(head, 0, 4) === 'OggS') return 'ogg'
  if (ascii(head, 0, 4) === 'fLaC') return 'flac'
  if (ascii(head, 0, 3) === 'ID3') return 'mp3'
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    // ADTS 与 MP3 帧头都落在 0xFFEx，用保护位区分：MP3 的 layer 不为 0
    const layer = (head[1] >> 1) & 0x03
    return layer === 0 ? 'aac' : 'mp3'
  }

  if (ascii(head, 4, 4) === 'ftyp' && head.length >= 12) {
    const brand = ascii(head, 8, 4)
    if (brand === 'avif' || brand === 'avis') return 'avif'
    if (brand === 'mif1' || brand === 'msf1' || brand === 'heic' || brand === 'heix') return 'heif'
    if (brand === 'qt  ') return 'mov'
    if (brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') return 'm4a'
    return 'mp4'
  }

  if (ascii(head, 0, 4) === 'OTTO') return 'otf'
  if (ascii(head, 0, 4) === 'wOFF') return 'woff'
  if (ascii(head, 0, 4) === 'wOF2') return 'woff2'
  if (ascii(head, 0, 4) === 'ttcf') return 'ttf'
  if (startsWith(head, [0x00, 0x01, 0x00, 0x00])) return 'ttf'
  if (ascii(head, 0, 4) === 'true' || ascii(head, 0, 4) === 'typ1') return 'ttf'

  if (ascii(head, 0, 2) === 'MZ') return 'exe'
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return 'elf'
  if (
    startsWith(head, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWith(head, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWith(head, [0xce, 0xfa, 0xed, 0xfe]) ||
    startsWith(head, [0xcf, 0xfa, 0xed, 0xfe])
  ) {
    return 'macho'
  }
  if (ascii(head, 0, 4) === '%PDF') return 'pdf'
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    return 'zip'
  }
  if (ascii(head, 0, 4) === 'Rar!') return 'rar'
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z'

  return 'unknown'
}

export function kindFamily(kind: FileKind): FileFamily {
  switch (kind) {
    case 'jpeg':
    case 'png':
    case 'gif':
    case 'webp':
    case 'bmp':
    case 'avif':
    case 'heif':
      return 'image'
    case 'mp4':
    case 'mov':
    case 'webm':
    case 'matroska':
      return 'video'
    case 'mp3':
    case 'aac':
    case 'wav':
    case 'ogg':
    case 'flac':
    case 'm4a':
      return 'audio'
    case 'ttf':
    case 'otf':
    case 'woff':
    case 'woff2':
      return 'font'
    case 'exe':
    case 'elf':
    case 'macho':
      return 'executable'
    case 'pdf':
      return 'pdf'
    case 'zip':
    case 'rar':
    case '7z':
      return 'archive'
    default:
      return 'unknown'
  }
}

export interface FileJudgement {
  ok: boolean
  kind: FileKind
  reason?: string
}

/**
 * 风险判定必须给出可读原因（§4.1）。
 * 可执行程序/文档/压缩包即使「类型能对上」也不算通过，因为它们不属于素材库的可用格式。
 */
export function judgeFile(head: Uint8Array, type: AssetType): FileJudgement {
  const kind = sniffKind(head)
  const family = kindFamily(kind)

  if (family === 'executable') {
    return { ok: false, kind, reason: '文件实际是可执行程序，已移入隔离区' }
  }
  if (family === 'pdf') {
    return { ok: false, kind, reason: '文件实际是 PDF 文档，与素材类型不符' }
  }
  if (family === 'archive') {
    return { ok: false, kind, reason: '文件实际是压缩包，与素材类型不符' }
  }
  if (family === 'unknown') {
    return { ok: false, kind, reason: '无法识别文件格式，可能存在风险' }
  }
  if (family !== type) {
    return {
      ok: false,
      kind,
      reason: `扩展名声明为${FAMILY_LABEL[type]}，实际内容却是${FAMILY_LABEL[family]}`
    }
  }
  return { ok: true, kind }
}
