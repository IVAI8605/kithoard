import fs from 'node:fs'
import path from 'node:path'

/** 隔离区文件操作（§5.1：`%APPDATA%/Kithoard/quarantine/`，只移入不删除） */

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export function pathExists(filePath: string): boolean {
  return fs.existsSync(filePath)
}

/**
 * 隔离文件名保留原文件名，前面加时间戳：用户看到 `172...-cat.jpg` 能认出是什么，
 * 同时避免同名任务互相覆盖。
 */
export function uniqueQuarantinePath(dir: string, targetPath: string): string {
  const base = path.basename(targetPath)
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  let candidate = path.join(dir, `${stamp}-${base}`)
  let index = 1
  while (pathExists(candidate)) {
    const ext = path.extname(base)
    const name = path.basename(base, ext)
    candidate = path.join(dir, `${stamp}-${name} (${index})${ext}`)
    index += 1
  }
  return candidate
}

/**
 * 跨盘移动：隔离区在 userData（通常 C:），下载目录可能在 D:，
 * `renameSync` 跨盘会抛 EXDEV；此时退化为「复制 → 删除源文件」，语义仍是移动而不是永久删除。
 */
export function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    fs.copyFileSync(from, to)
    fs.unlinkSync(from)
  }
}
