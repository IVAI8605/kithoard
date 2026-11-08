import fs from 'node:fs'
import path from 'node:path'
import { makeError } from '@shared/errors'

/**
 * 本地素材的文件写操作只在这里做参数校验，service 负责落盘与记账。
 * 拆开的原因：改名/移动/删除都会碰用户文件，规则必须能被单测穷举，
 * 而且 V1.1 的 Agent 接口要复用同一份规则，不能只靠界面拦。
 */

const ILLEGAL_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const MAX_NAME_CODE_POINTS = 120
const MAX_PATH = 259
const MAX_IDS = 200

/** 盘符根下的第一层目录，命中即拒绝；只在第一层比对，`D:\my\windows` 不会被误伤 */
const ROOT_FORBIDDEN = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'perflogs',
  'recovery'
])
/** 任何盘、任何层级都属于系统所有，不放行 */
const ALWAYS_FORBIDDEN = new Set(['$recycle.bin', 'system volume information'])

export interface RenamePlan {
  from: string
  to: string
  /** 最终文件名（含扩展名），用于回写下载任务与列表 */
  fileName: string
}

/**
 * 只允许改文件名主体，扩展名必须保持一致。
 * 理由：扩展名决定系统用什么程序打开，也决定后续魔数校验的预期；
 * 允许把 .jpg 改成 .exe 等于绕过安全边界。
 */
export function planRename(currentPath: string, rawName: unknown): RenamePlan {
  if (typeof rawName !== 'string') throw makeError('E_INVALID_ARG', 'newName')
  const input = rawName.trim()
  if (!input) throw makeError('E_INVALID_ARG', 'newName')
  if (Array.from(input).length > MAX_NAME_CODE_POINTS) throw makeError('E_INVALID_ARG', 'newName')

  const currentExt = path.win32.extname(currentPath)
  const currentBase = path.win32.basename(currentPath, currentExt)

  // 只有输入扩展名与当前一致时才把它当扩展名剥掉；其余点号视为名字的一部分。
  // 这样「photo.exe」会变成「photo.exe.jpg」而不是被拒绝，既保留用户输入又不可能改掉真实类型。
  let base = input
  const inputExt = path.win32.extname(input)
  if (inputExt && inputExt.toLowerCase() === currentExt.toLowerCase()) {
    base = path.win32.basename(input, inputExt)
  }

  assertNameBody(base, currentBase)
  const dir = path.win32.dirname(currentPath)
  const fileName = `${base}${currentExt}`
  return { from: currentPath, to: path.win32.join(dir, fileName), fileName }
}

/**
 * 目标目录校验：绝对路径、真实存在、不是系统目录、不是盘符根。
 * 只做只读检查，不创建目录——用户选错路径时应该被告知，而不是被我们悄悄建一堆目录。
 */
export function assertMovableDir(rawDir: unknown): string {
  if (typeof rawDir !== 'string' || !rawDir.trim()) throw makeError('E_DIR_FORBIDDEN', 'targetDir')
  const dir = path.win32.normalize(rawDir.trim())
  if (!path.win32.isAbsolute(dir)) throw makeError('E_DIR_FORBIDDEN', 'targetDir')

  let info: fs.Stats
  try {
    info = fs.statSync(dir)
  } catch {
    throw makeError('E_DIR_FORBIDDEN', 'targetDir')
  }
  if (!info.isDirectory()) throw makeError('E_DIR_FORBIDDEN', 'targetDir')

  const lower = dir.toLowerCase().replace(/\\+$/, '')
  if (/^[a-z]:$/.test(lower)) throw makeError('E_DIR_FORBIDDEN', 'targetDir')

  // 按目录段判断：盘符根下第一层命中系统目录、或任意层级属于系统保留目录，都拒绝
  const segments = lower.split('\\').filter(Boolean)
  const rest = segments.slice(1)
  if (rest.length > 0 && ROOT_FORBIDDEN.has(rest[0])) throw makeError('E_DIR_FORBIDDEN', 'targetDir')
  if (rest.some((name) => ALWAYS_FORBIDDEN.has(name))) throw makeError('E_DIR_FORBIDDEN', 'targetDir')
  // `C:\Users` 只是容器，允许 C:\Users\name 及其子目录
  if (rest.length === 1 && rest[0] === 'users') throw makeError('E_DIR_FORBIDDEN', 'targetDir')

  return dir
}

/** 批量操作统一限制 200 条（§6.3），去重后保持原顺序 */
export function readIds(raw: unknown): number[] {
  const value = typeof raw === 'object' && raw !== null ? (raw as { ids?: unknown }).ids : undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IDS) {
    throw makeError('E_INVALID_ARG', 'ids')
  }
  const seen = new Set<number>()
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) {
      throw makeError('E_INVALID_ARG', 'ids')
    }
    seen.add(item)
  }
  return [...seen]
}

/** 移动后目标不能超过 Windows 路径上限，否则写入时才失败，用户已经等了半天 */
export function assertPathLength(targetPath: string): void {
  if (targetPath.length > MAX_PATH) throw makeError('E_INVALID_ARG', 'targetPath')
}

function assertNameBody(base: string, currentBase: string): void {
  const chars = Array.from(base)
  if (chars.length === 0) throw makeError('E_INVALID_ARG', 'newName')
  if (chars.length > MAX_NAME_CODE_POINTS) throw makeError('E_INVALID_ARG', 'newName')
  for (const char of chars) {
    if (ILLEGAL_CHARS.has(char) || char.charCodeAt(0) < 32) {
      throw makeError('E_INVALID_ARG', 'newName')
    }
  }
  if (/[. ]$/.test(base)) throw makeError('E_INVALID_ARG', 'newName')
  if (RESERVED_DEVICE.test(base)) throw makeError('E_INVALID_ARG', 'newName')
  // 与原名完全一致没有意义；只改大小写时 base 与原名的字符串不同，会正常放行
  if (base === currentBase) throw makeError('E_INVALID_ARG', 'newName')
}
