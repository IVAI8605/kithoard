import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import type { ImageProcessOptions } from '../src/shared/types'
import {
  compressImageFile,
  transformImageFile,
  validateOptions
} from '../src/main/media/image'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithoard-media-test-'))

beforeAll(() => {
  fs.mkdirSync(dir, { recursive: true })
})
afterAll(() => {
  // 测试目录留在系统临时目录，由系统清理；不在这里做永久删除
})

async function makePng(name: string): Promise<string> {
  const file = path.join(dir, name)
  await sharp({
    create: { width: 100, height: 80, channels: 3, background: '#c06040' }
  })
    .png()
    .toFile(file)
  return file
}

async function makeNoisyJpeg(name: string): Promise<string> {
  const width = 400
  const height = 300
  const raw = Buffer.alloc(width * height * 3)
  for (let index = 0; index < raw.length; index += 1) {
    raw[index] = (index * 37) % 256
  }
  const file = path.join(dir, name)
  await sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 100 })
    .toFile(file)
  return file
}

describe('图片处理参数校验', () => {
  it('拒绝非法动作、格式与质量', () => {
    const bad: unknown[] = [
      { action: 'resize' },
      { action: 'convert' },
      { action: 'convert', format: 'gif' },
      { action: 'convert', format: 'webp', quality: 0 },
      { action: 'convert', format: 'webp', quality: 101 },
      { action: 'convert', format: 'webp', quality: 1.5 }
    ]
    for (const options of bad) {
      expect(() => validateOptions(options as ImageProcessOptions)).toThrow()
    }
  })

  it('编辑至少要有一种操作，且裁剪与尺寸必须合法', () => {
    const bad: unknown[] = [
      { action: 'edit', edit: {} },
      { action: 'edit', edit: { crop: { left: -1, top: 0, width: 10, height: 10 } } },
      { action: 'edit', edit: { crop: { left: 0, top: 0, width: 0, height: 10 } } },
      { action: 'edit', edit: { rotate: 361 } },
      { action: 'edit', edit: { resize: {} } },
      { action: 'edit', edit: { resize: { width: 0 } } }
    ]
    for (const options of bad) {
      expect(() => validateOptions(options as ImageProcessOptions)).toThrow()
    }
  })

  it('合法参数原样返回', () => {
    const options: ImageProcessOptions = { action: 'convert', format: 'webp', quality: 75 }
    expect(validateOptions(options)).toBe(options)
  })
})

describe('图片转换与编辑', () => {
  it('PNG 转 WebP：另存新文件，原图仍在，尺寸不变', async () => {
    const input = await makePng('convert-source.png')
    const result = await transformImageFile(input, { action: 'convert', format: 'webp' })

    expect(result.format).toBe('webp')
    expect(result.bytes).toBeGreaterThan(0)
    expect(path.extname(result.outputPath)).toBe('.webp')
    expect(fs.existsSync(input)).toBe(true)
    const meta = await sharp(result.outputPath).metadata()
    expect(meta.format).toBe('webp')
    expect(meta.width).toBe(100)
    expect(meta.height).toBe(80)
  })

  it('旋转 90 度再缩放到宽 50：组合输出尺寸正确', async () => {
    const input = await makePng('edit-source.png')
    const result = await transformImageFile(input, {
      action: 'edit',
      edit: { rotate: 90, resize: { width: 50 } }
    })

    const meta = await sharp(result.outputPath).metadata()
    expect(meta.width).toBe(50)
    // 原图 100x80 旋转后为 80x100，等比缩到宽 50 后高应为 62 左右
    expect(meta.height).toBeGreaterThanOrEqual(60)
    expect(meta.height).toBeLessThanOrEqual(64)
    expect(fs.existsSync(input)).toBe(true)
  })

  it('同名输出自动加序号，不覆盖已有文件', async () => {
    const input = await makePng('dup-source.png')
    const first = await transformImageFile(input, { action: 'convert', format: 'webp' })
    const second = await transformImageFile(input, { action: 'convert', format: 'webp' })
    expect(second.outputPath).not.toBe(first.outputPath)
    expect(fs.existsSync(first.outputPath)).toBe(true)
    expect(fs.existsSync(second.outputPath)).toBe(true)
  })
})

describe('图片压缩', () => {
  it('覆盖原文件且体积下降，产物仍可解码', async () => {
    const input = await makeNoisyJpeg('compress-source.jpg')
    const before = fs.statSync(input).size
    const result = await compressImageFile(input)

    expect(result.outputPath).toBe(input)
    expect(result.bytes).toBeLessThan(before)
    const meta = await sharp(input).metadata()
    expect(meta.width).toBe(400)
    expect(meta.height).toBe(300)
  })

  it('损坏输入报错且原文件不变', async () => {
    const input = path.join(dir, 'broken.jpg')
    const content = 'this is not an image'
    fs.writeFileSync(input, content)

    await expect(compressImageFile(input)).rejects.toThrow()
    expect(fs.readFileSync(input, 'utf8')).toBe(content)
    // 失败后不留下半成品临时文件
    const leftovers = fs.readdirSync(dir).filter((name) => name.startsWith('broken.jpg.kithoard-'))
    expect(leftovers).toEqual([])
  })

  it('BMP 不支持压缩，明确拒绝', async () => {
    const input = path.join(dir, 'plain.bmp')
    fs.writeFileSync(input, 'bmp')
    await expect(compressImageFile(input)).rejects.toThrow()
  })
})
