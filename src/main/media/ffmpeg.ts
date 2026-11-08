import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { makeError } from '@shared/errors'

/** FFmpeg 静态二进制随包到 resources/bin，打包后不依赖系统 PATH（§7.7-1） */
export function ffmpegPath(): string {
  // 打包后从 resources 下找；单测等纯 Node 环境没有 resourcesPath，回落到项目目录
  const resourcesPath = process.resourcesPath
  if (resourcesPath) {
    const packed = path.join(resourcesPath, 'bin', 'ffmpeg.exe')
    if (fs.existsSync(packed)) return packed
  }
  return path.join(process.cwd(), 'resources', 'bin', 'ffmpeg.exe')
}

/** 启动自检与处理前检查：二进制缺失时给 E_FFMPEG_MISSING，而不是让 spawn 抛英文错误 */
export function isFfmpegAvailable(): boolean {
  const dir = path.dirname(ffmpegPath())
  return fs.existsSync(path.join(dir, 'ffmpeg.exe')) && fs.existsSync(path.join(dir, 'ffprobe.exe'))
}

export interface FFProbeStream {
  codec_type: string
  codec_name: string
  width?: number
  height?: number
  duration?: string
  bit_rate?: string
}

export interface FFProbeResult {
  streams: FFProbeStream[]
  format: { duration?: string; size?: string; bit_rate?: string }
}

/** 探测媒体文件；文件不存在或不是媒体时抛 E_MEDIA_UNSUPPORTED */
export async function probeMedia(inputPath: string): Promise<FFProbeResult> {
  try {
    const stdout = execFileSync(
      ffmpegPath().replace('ffmpeg.exe', 'ffprobe.exe'),
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name,width,height,duration,bit_rate',
        '-show_entries',
        'format=duration,size,bit_rate',
        '-of',
        'json',
        inputPath
      ],
      { encoding: 'utf8' }
    )
    return JSON.parse(stdout)
  } catch (error) {
    throw makeError(
      'E_MEDIA_UNSUPPORTED',
      error instanceof Error ? error.message : String(error)
    )
  }
}

/** 解析 ffmpeg -progress 输出的一行，提取当前处理时间（秒） */
export function parseProgressLine(line: string): { timeSeconds?: number } {
  const match = line.match(/^time=(\d{2}):(\d{2}):(\d{2}\.\d{2})$/)
  if (!match) return {}
  const [, h, m, s] = match
  return { timeSeconds: Number(h) * 3600 + Number(m) * 60 + Number(s) }
}

/** 视频转码命令：H.264 + AAC，CRF 控制质量，可选分辨率与码率 */
export function buildVideoConvertCommand(
  inputPath: string,
  outputPath: string,
  options: { crf?: number; width?: number; height?: number; bitrate?: string }
): string[] {
  const args: string[] = ['-y', '-i', inputPath, '-c:v', 'libx264', '-preset', 'medium']
  if (options.crf !== undefined) args.push('-crf', String(options.crf))
  if (options.bitrate) args.push('-b:v', options.bitrate)
  if (options.width || options.height) {
    args.push('-vf', `scale=${options.width ?? -2}:${options.height ?? -2}`)
  }
  args.push('-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath)
  return args
}

/** 视频压缩命令：自动 CRF 28，保留音频 */
export function buildVideoCompressCommand(inputPath: string, outputPath: string): string[] {
  return buildVideoConvertCommand(inputPath, outputPath, { crf: 28 })
}

/** 视频截图：指定时间抽一帧为 JPG */
export function buildVideoScreenshotCommand(inputPath: string, outputPath: string, at: string): string[] {
  return ['-y', '-ss', at, '-i', inputPath, '-frames:v', '1', '-q:v', '2', outputPath]
}

/** 音频转码命令：可调码率 */
export function buildAudioConvertCommand(
  inputPath: string,
  outputPath: string,
  options: { bitrate?: string; format?: 'mp3' | 'aac' | 'wav' | 'flac' }
): string[] {
  const args: string[] = ['-y', '-i', inputPath]
  if (options.format === 'wav' || options.format === 'flac') {
    args.push('-c:a', options.format === 'wav' ? 'pcm_s16le' : 'flac')
  } else {
    const encoder = options.format === 'aac' ? 'aac' : 'libmp3lame'
    args.push('-c:a', encoder, '-b:a', options.bitrate ?? '128k')
  }
  args.push(outputPath)
  return args
}

/** 音频压缩：自动码率（mp3 128k） */
export function buildAudioCompressCommand(inputPath: string, outputPath: string): string[] {
  return buildAudioConvertCommand(inputPath, outputPath, { bitrate: '128k' })
}

/** 音频截取：起止时间，另存新文件 */
export function buildAudioExtractCommand(inputPath: string, outputPath: string, start: string, end: string): string[] {
  return ['-y', '-ss', start, '-to', end, '-i', inputPath, '-c:a', 'copy', outputPath]
}

/** 执行 ffmpeg，支持取消；进度通过 signal 传入的回调上报 */
export function runFfmpeg(
  args: string[],
  signal: AbortSignal,
  onProgress?: (timeSeconds: number) => void
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      for (const line of text.split('\n')) {
        const parsed = parseProgressLine(line)
        if (parsed.timeSeconds !== undefined && onProgress) onProgress(parsed.timeSeconds)
      }
    })
    proc.on('close', (code) => resolve({ code, stderr }))
    proc.on('error', reject)
    signal.addEventListener('abort', () => {
      try {
        proc.kill('SIGTERM')
      } catch {
        // 进程已结束
      }
    })
  })
}
