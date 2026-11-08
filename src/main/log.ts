import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { redactLine } from '@shared/log-redact'

// 需求要求「不向用户暴露日志功能」，但排查下载/搜索失败需要痕迹，因此只落盘、不开 UI 入口
const MAX_BYTES = 2 * 1024 * 1024
const MAX_FILES = 3

let logDir = ''

export function initLogging(userDataDir: string): void {
  logDir = path.join(userDataDir, 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  rotateIfNeeded()
  write('INFO', `version=${app.getVersion()}`)
}

function currentFile(): string {
  return path.join(logDir, 'kithoard.log')
}

function rotateIfNeeded(): void {
  const file = currentFile()
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < MAX_BYTES) return
    // 只保留 kithoard.log / .2 / .3 三份，最旧的先被覆盖
    for (let index = MAX_FILES - 1; index >= 1; index -= 1) {
      const from = index === 1 ? file : path.join(logDir, `kithoard.${index}.log`)
      const to = path.join(logDir, `kithoard.${index + 1}.log`)
      if (fs.existsSync(from)) {
        if (fs.existsSync(to)) fs.rmSync(to, { force: true })
        fs.renameSync(from, to)
      }
    }
  } catch {
    // 轮转失败不能影响主流程
  }
}

function write(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  if (!logDir) return
  try {
    rotateIfNeeded()
    const line = `${new Date().toISOString()} ${level} ${redactLine(message)}\n`
    fs.appendFileSync(currentFile(), line, 'utf8')
  } catch {
    // 日志写不进去时静默降级，绝不让日志异常冒到界面
  }
}

export const log = {
  info: (message: string): void => write('INFO', message),
  warn: (message: string): void => write('WARN', message),
  error: (message: string): void => write('ERROR', message)
}
