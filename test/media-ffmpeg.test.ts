import { describe, expect, it } from 'vitest'
import type { MediaProcessOptions } from '../src/shared/types'
import {
  buildAudioCompressCommand,
  buildAudioConvertCommand,
  buildAudioExtractCommand,
  buildVideoCompressCommand,
  buildVideoConvertCommand,
  buildVideoScreenshotCommand,
  isFfmpegAvailable,
  parseProgressLine
} from '../src/main/media/ffmpeg'
import { validateMediaOptions } from '../src/main/services/media'

describe('FFmpeg 命令生成', () => {
  it('视频转码使用 libx264 + AAC，并带上分辨率与 CRF', () => {
    const args = buildVideoConvertCommand('in.mp4', 'out.mp4', {
      crf: 23,
      width: 1280,
      height: 720
    })
    expect(args).toContain('libx264')
    expect(args).toContain('aac')
    expect(args).toContain('-crf')
    expect(args[args.indexOf('-crf') + 1]).toBe('23')
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=1280:720')
    expect(args[args.length - 1]).toBe('out.mp4')
  })

  it('视频压缩固定 CRF 28', () => {
    const args = buildVideoCompressCommand('in.mkv', 'out.mp4')
    expect(args[args.indexOf('-crf') + 1]).toBe('28')
  })

  it('截图命令包含 -ss 与单帧参数', () => {
    const args = buildVideoScreenshotCommand('in.mp4', 'shot.jpg', '00:00:05')
    expect(args[args.indexOf('-ss') + 1]).toBe('00:00:05')
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1')
    expect(args[args.length - 1]).toBe('shot.jpg')
  })

  it('音频转码按格式选择编码器', () => {
    expect(buildAudioConvertCommand('a.wav', 'b.mp3', { format: 'mp3' })).toContain('libmp3lame')
    expect(buildAudioConvertCommand('a.mp3', 'b.wav', { format: 'wav' })).toContain('pcm_s16le')
    expect(buildAudioConvertCommand('a.mp3', 'b.flac', { format: 'flac' })).toContain('flac')
  })

  it('音频压缩默认 128k，截取命令带起止时间', () => {
    const compress = buildAudioCompressCommand('a.wav', 'b.mp3')
    expect(compress[compress.indexOf('-b:a') + 1]).toBe('128k')
    const extract = buildAudioExtractCommand('a.mp3', 'b.mp3', '00:00:01', '00:00:06')
    expect(extract[extract.indexOf('-ss') + 1]).toBe('00:00:01')
    expect(extract[extract.indexOf('-to') + 1]).toBe('00:00:06')
  })

  it('进度行解析出秒数，普通日志行返回空', () => {
    expect(parseProgressLine('time=00:01:05.50').timeSeconds).toBeCloseTo(65.5)
    expect(parseProgressLine('frame= 100 fps=25')).toEqual({})
  })

  it('随包二进制存在时自检通过', () => {
    expect(isFfmpegAvailable()).toBe(true)
  })
})

describe('音视频参数校验', () => {
  it('拒绝非法时间、码率与 CRF', () => {
    const bad: MediaProcessOptions[] = [
      { action: 'videoScreenshot', at: '5秒' },
      { action: 'videoConvert', crf: 60 },
      { action: 'videoConvert', bitrate: 'fast' },
      { action: 'audioConvert', format: 'ogg' as never },
      { action: 'audioExtract', start: '00:00:10', end: '00:00:05' }
    ]
    for (const options of bad) {
      expect(() => validateMediaOptions(options)).toThrow()
    }
  })

  it('合法音视频参数通过', () => {
    expect(
      validateMediaOptions({ action: 'videoConvert', crf: 23, width: 1280, bitrate: '1500k' })
    ).toBeTruthy()
    expect(validateMediaOptions({ action: 'audioExtract', start: '00:00:01', end: '00:00:06' })).toBeTruthy()
  })
})
