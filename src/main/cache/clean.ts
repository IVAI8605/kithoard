import fs from 'node:fs'
import path from 'node:path'

/** §5.1：缓存只清缩略图与接口响应；`.part` 属于下载临时文件，永不参与 */
const CLEANABLE_DIRS = ['thumbs', 'http']
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface CacheCleanResult {
  removed: number
  bytes: number
}

/**
 * 只处理 cache 下已知的两个子目录，并且跳过任何 `.part`。
 * 缓存属于 §5.8 的「应用临时文件」例外，可以物理清理；用户素材永远不在这里。
 */
export function cleanCache(cacheRoot: string, maxAgeMs = DEFAULT_MAX_AGE_MS): CacheCleanResult {
  const cutoff = Date.now() - maxAgeMs
  const result: CacheCleanResult = { removed: 0, bytes: 0 }

  for (const dirName of CLEANABLE_DIRS) {
    const dir = path.join(cacheRoot, dirName)
    for (const file of collectFiles(dir)) {
      if (file.endsWith('.part')) continue
      try {
        const info = fs.statSync(file)
        if (info.mtimeMs > cutoff) continue
        fs.unlinkSync(file)
        result.removed += 1
        result.bytes += info.size
      } catch {
        // 单个文件被占用或已消失都不能影响整轮清理
      }
    }
  }
  return result
}

/** 统计缓存占用，供设置页展示；口径与清理范围保持一致 */
export function cacheSize(cacheRoot: string): number {
  let total = 0
  for (const dirName of CLEANABLE_DIRS) {
    for (const file of collectFiles(path.join(cacheRoot, dirName))) {
      try {
        total += fs.statSync(file).size
      } catch {
        // 统计时被清理掉的文件直接跳过
      }
    }
  }
  return total
}

function collectFiles(dir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(full))
    else if (entry.isFile()) files.push(full)
  }
  return files
}
