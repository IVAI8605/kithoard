import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { makeError } from '@shared/errors'
import type { ImageFormat, ImageProcessOptions } from '@shared/types'

/** 单张图片像素上限与尺寸上限：防止用户把 2 万像素的原图直接送进内存 */
const MAX_DIMENSION = 20000
const MAX_QUALITY = 100
const DEFAULT_QUALITY: Record<ImageFormat, number> = {
  jpeg: 82,
  png: 82,
  webp: 80,
  avif: 55
}

const FORMAT_EXT: Record<ImageFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif'
}

const MIME: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif'
}

export interface ImageTransformResult {
  outputPath: string
  bytes: number
  format: ImageFormat
}

function formatFromPath(filePath: string): ImageFormat | null {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg'
  if (ext === '.png') return 'png'
  if (ext === '.webp') return 'webp'
  if (ext === '.avif') return 'avif'
  return null
}

function isBmp(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.bmp'
}

/** 校验输出参数；参数错误统一 E_INVALID_ARG，不让 sharp 的英文异常冒到界面 */
export function validateOptions(raw: ImageProcessOptions): ImageProcessOptions {
  if (!['convert', 'compress', 'edit'].includes(raw.action)) {
    throw makeError('E_INVALID_ARG', 'action')
  }
  const format = raw.format ?? null
  if (format !== null && !(format in FORMAT_EXT)) throw makeError('E_INVALID_ARG', 'format')
  if (raw.quality !== undefined) {
    if (!Number.isInteger(raw.quality) || raw.quality < 1 || raw.quality > MAX_QUALITY) {
      throw makeError('E_INVALID_ARG', 'quality')
    }
  }
  if (raw.action === 'convert' && format === null) throw makeError('E_INVALID_ARG', 'format')

  if (raw.action === 'edit') {
    const edit = raw.edit
    if (!edit || typeof edit !== 'object') throw makeError('E_INVALID_ARG', 'edit')
    if (edit.crop) {
      const crop = edit.crop
      for (const key of ['left', 'top', 'width', 'height'] as const) {
        const value = crop[key]
        if (!Number.isInteger(value) || value < 0 || value > MAX_DIMENSION) {
          throw makeError('E_INVALID_ARG', `crop.${key}`)
        }
      }
      if (crop.width === 0 || crop.height === 0) throw makeError('E_INVALID_ARG', 'crop')
    }
    if (edit.rotate !== undefined) {
      if (!Number.isFinite(edit.rotate) || edit.rotate < 0 || edit.rotate > 360) {
        throw makeError('E_INVALID_ARG', 'rotate')
      }
    }
    if (edit.flip !== undefined && edit.flip !== 'horizontal' && edit.flip !== 'vertical') {
      throw makeError('E_INVALID_ARG', 'flip')
    }
    if (edit.resize) {
      const { width, height } = edit.resize
      if (width === undefined && height === undefined) throw makeError('E_INVALID_ARG', 'resize')
      for (const value of [width, height]) {
        if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSION)) {
          throw makeError('E_INVALID_ARG', 'resize')
        }
      }
    }
    if (!edit.crop && edit.rotate === undefined && !edit.flip && !edit.resize) {
      throw makeError('E_INVALID_ARG', 'edit')
    }
  }

  if ((raw.action === 'compress' || raw.action === 'edit') && raw.format && format === null) {
    throw makeError('E_INVALID_ARG', 'format')
  }
  return raw
}

/** 同名文件加 (1)(2)，不覆盖用户已有文件 */
function uniquePath(targetDir: string, baseName: string, ext: string): string {
  let candidate = path.join(targetDir, `${baseName}.${ext}`)
  let index = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(targetDir, `${baseName} (${index}).${ext}`)
    index += 1
  }
  return candidate
}

function encodeOptions(format: ImageFormat, quality?: number): Record<string, unknown> {
  const value = quality ?? DEFAULT_QUALITY[format]
  if (format === 'png') {
    // PNG 的 quality 映射到调色板压缩质量，压缩级别固定 9，优先减小体积
    return { compressionLevel: 9, palette: true, quality: value }
  }
  return { quality: value }
}

async function outputInfo(outputPath: string, format: ImageFormat): Promise<ImageTransformResult> {
  const stat = await fs.promises.stat(outputPath)
  if (!stat.isFile() || stat.size === 0) throw makeError('E_VERIFY_FAILED', 'empty output')
  return { outputPath, bytes: stat.size, format }
}

/**
 * 转换 / 编辑：一律另存新文件，原文件不动。
 * 输出目录沿用输入所在目录，命名加后缀，避免用户找不到产物。
 */
export async function transformImageFile(
  inputPath: string,
  options: ImageProcessOptions
): Promise<ImageTransformResult> {
  const sourceFormat = formatFromPath(inputPath)
  // BMP 等无输出编码器的格式仍可作为输入；编辑时保留不了原格式就落到 PNG
  const format = options.format ?? (options.action === 'edit' ? (sourceFormat ?? 'png') : null)
  if (!format) throw makeError('E_INVALID_ARG', 'format')

  const suffix = options.action === 'convert' ? '' : '-edited'
  const baseName = path.basename(inputPath, path.extname(inputPath))
  const targetDir = path.dirname(inputPath)
  const outputPath = uniquePath(targetDir, `${baseName}${suffix}`, FORMAT_EXT[format])

  let pipeline = sharp(inputPath, { failOn: 'error' })
  if (options.action === 'edit' && options.edit) {
    const edit = options.edit
    if (edit.rotate !== undefined && edit.rotate !== 0) pipeline = pipeline.rotate(edit.rotate)
    if (edit.flip === 'horizontal') pipeline = pipeline.flop()
    if (edit.flip === 'vertical') pipeline = pipeline.flip()
    if (edit.resize) {
      pipeline = pipeline.resize({
        width: edit.resize.width,
        height: edit.resize.height,
        fit: 'inside',
        withoutEnlargement: true
      })
    }
    if (edit.crop) {
      pipeline = pipeline.extract({
        left: edit.crop.left,
        top: edit.crop.top,
        width: edit.crop.width,
        height: edit.crop.height
      })
    }
  }

  try {
    await pipeline.toFormat(format, encodeOptions(format, options.quality) as never).toFile(outputPath)
  } catch (error) {
    // sharp 失败时可能留下半个文件，清掉再报错，避免用户在目录里看到坏图
    try {
      fs.unlinkSync(outputPath)
    } catch {
      // 没生成就不用清
    }
    throw makeError(
      'E_MEDIA_UNSUPPORTED',
      error instanceof Error ? error.message : String(error)
    )
  }
  return outputInfo(outputPath, format)
}

/**
 * 压缩：默认覆盖原文件（§7.6-3）。
 * 先写临时文件并校验可读，再原子替换；任何一步失败都保留原文件。
 */
export async function compressImageFile(
  inputPath: string,
  quality?: number
): Promise<ImageTransformResult> {
  const sourceFormat = formatFromPath(inputPath)
  if (!sourceFormat) {
    throw makeError('E_MEDIA_UNSUPPORTED', isBmp(inputPath) ? 'bmp compress' : inputPath)
  }

  const tempPath = `${inputPath}.kithoard-${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    await sharp(inputPath, { failOn: 'error' })
      .toFormat(sourceFormat, encodeOptions(sourceFormat, quality) as never)
      .toFile(tempPath)
    // 校验产物真的能解码，防止只写了文件头就替换原图
    const meta = await sharp(tempPath).metadata()
    if (!meta.width || !meta.height) throw makeError('E_VERIFY_FAILED', 'no dimensions')
    fs.renameSync(tempPath, inputPath)
  } catch (error) {
    try {
      fs.unlinkSync(tempPath)
    } catch {
      // 临时文件可能根本没生成
    }
    if (error && typeof error === 'object' && 'code' in error) throw error
    throw makeError(
      'E_MEDIA_UNSUPPORTED',
      error instanceof Error ? error.message : String(error)
    )
  }
  const stat = fs.statSync(inputPath)
  return { outputPath: inputPath, bytes: stat.size, format: sourceFormat }
}

export function mimeOf(format: ImageFormat): string {
  return MIME[format]
}
