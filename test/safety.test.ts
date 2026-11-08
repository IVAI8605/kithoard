import { describe, expect, it } from 'vitest'
import { judgeFile, kindFamily, sniffKind } from '../src/main/safety/magic'
import { checkDownloadUrl, LARGE_FILE_BYTES, needsLargeFileConfirm } from '../src/main/safety/policy'

function bytes(values: number[]): Uint8Array {
  return Uint8Array.from(values)
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from([...text].map((char) => char.charCodeAt(0)))
}

function ftyp(brand: string): Uint8Array {
  return Uint8Array.from([0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii(brand)])
}

describe('下载前扩展名拦截', () => {
  it('图片素材允许 jpg，忽略查询串', () => {
    expect(checkDownloadUrl('https://cdn.example.com/a/b.jpg?x=1', 'image').ok).toBe(true)
  })

  it('可执行文件直接拒绝', () => {
    expect(checkDownloadUrl('https://cdn.example.com/a.exe', 'image')).toEqual({
      ok: false,
      reason: '不允许下载 .exe 类型文件'
    })
  })

  it('压缩包与 PDF 直接拒绝', () => {
    expect(checkDownloadUrl('https://cdn.example.com/a.zip', 'image').ok).toBe(false)
    expect(checkDownloadUrl('https://cdn.example.com/a.pdf', 'image').ok).toBe(false)
  })

  it('扩展名与素材类型不匹配时拒绝', () => {
    expect(checkDownloadUrl('https://cdn.example.com/a.mp3', 'image').ok).toBe(false)
  })

  it('没有扩展名时放行，交给魔数兜底', () => {
    expect(checkDownloadUrl('https://cdn.example.com/download/12345', 'image').ok).toBe(true)
  })

  it('模板类型当前一律拒绝', () => {
    expect(checkDownloadUrl('https://cdn.example.com/a.zip', 'template').ok).toBe(false)
  })

  it('大小达到阈值才要求确认', () => {
    expect(needsLargeFileConfirm(null)).toBe(false)
    expect(needsLargeFileConfirm(LARGE_FILE_BYTES - 1)).toBe(false)
    expect(needsLargeFileConfirm(LARGE_FILE_BYTES)).toBe(true)
  })
})

describe('魔数识别', () => {
  it('识别常见图片', () => {
    expect(sniffKind(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
    expect(sniffKind(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('png')
    expect(sniffKind(ascii('GIF89a'))).toBe('gif')
    expect(sniffKind(Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')]))).toBe('webp')
  })

  it('识别视频容器', () => {
    expect(sniffKind(ftyp('isom'))).toBe('mp4')
    expect(sniffKind(ftyp('qt  '))).toBe('mov')
    expect(sniffKind(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x01]))).toBe('matroska')
  })

  it('识别音频', () => {
    expect(sniffKind(ascii('ID3'))).toBe('mp3')
    expect(sniffKind(ascii('fLaC'))).toBe('flac')
    expect(sniffKind(Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]))).toBe('wav')
  })

  it('识别字体', () => {
    expect(sniffKind(ascii('wOF2'))).toBe('woff2')
    expect(sniffKind(ascii('OTTO'))).toBe('otf')
  })

  it('识别高风险类型', () => {
    expect(sniffKind(ascii('MZ'))).toBe('exe')
    expect(sniffKind(bytes([0x7f, 0x45, 0x4c, 0x46]))).toBe('elf')
    expect(sniffKind(ascii('%PDF'))).toBe('pdf')
    expect(sniffKind(bytes([0x50, 0x4b, 0x03, 0x04]))).toBe('zip')
  })

  it('样本不足或无法识别时返回 unknown', () => {
    expect(sniffKind(bytes([0x00]))).toBe('unknown')
    expect(sniffKind(ascii('hello world'))).toBe('unknown')
  })

  it('家族映射供判定使用', () => {
    expect(kindFamily('jpeg')).toBe('image')
    expect(kindFamily('m4a')).toBe('audio')
    expect(kindFamily('exe')).toBe('executable')
    expect(kindFamily('zip')).toBe('archive')
  })
})

describe('下载后内容判定', () => {
  it('真实图片与素材类型一致时通过', () => {
    expect(judgeFile(bytes([0xff, 0xd8, 0xff, 0xe0]), 'image')).toEqual({
      ok: true,
      kind: 'jpeg'
    })
  })

  it('伪装成 jpg 的可执行文件被拦截', () => {
    const result = judgeFile(ascii('MZ\x90\x00'), 'image')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('可执行程序')
  })

  it('图片位置放了视频时判定不符', () => {
    const result = judgeFile(ftyp('isom'), 'image')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('图片')
    expect(result.reason).toContain('视频')
  })

  it('PDF 与压缩包即使类型能对上也不放行', () => {
    expect(judgeFile(ascii('%PDF'), 'image').ok).toBe(false)
    expect(judgeFile(bytes([0x50, 0x4b, 0x03, 0x04]), 'image').ok).toBe(false)
  })

  it('无法识别的文件按风险处理', () => {
    const result = judgeFile(ascii('hello world'), 'image')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('无法识别')
  })
})
