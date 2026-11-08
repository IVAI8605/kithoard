import path from 'node:path'
import { makeError } from '@shared/errors'

/** Windows 非法字符；用空格替换而不是直接删掉，避免「a<b>c」变成不可读的「ac」 */
const ILLEGAL_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
const TRAILING_DOTS_OR_SPACES = /[. ]+$/
/** Windows 保留设备名：即使加了扩展名也不能作为文件名（§7.4-10） */
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const MAX_NAME_CODE_POINTS = 120
/** 260 是含结尾空字符的上限，能给文件系统用的只有 259 */
const MAX_PATH = 259
const MAX_DEDUPE_ATTEMPTS = 1000

/**
 * 全库统一「盘符小写 + 反斜杠」规范形（§5.2）。
 * 大小写不同但指向同一文件的路径必须落成同一个字符串，否则 UNIQUE 约束形同虚设。
 */
export function normalizePath(input: string): string {
  const slashed = input.replace(/\//g, '\\')
  return /^[a-zA-Z]:/.test(slashed) ? slashed[0].toLowerCase() + slashed.slice(1) : slashed
}

/** 只认 URL 路径里的 1–8 位字母数字扩展名，防止把查询串带进文件名 */
export function extFromUrl(url: string): string | null {
  try {
    const ext = path.extname(new URL(url).pathname).replace('.', '').toLowerCase()
    return /^[a-z0-9]{1,8}$/.test(ext) ? ext : null
  } catch {
    return null
  }
}

/** 把素材标题变成可用的文件名主体（不含扩展名） */
export function sanitizeBaseName(title: string, fallback = '未命名'): string {
  let base = Array.from(title)
    .map((char) => (isIllegal(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TRAILING_DOTS_OR_SPACES, '')
  if (!base) base = fallback
  // 保留名加前缀而不是改名换姓，用户还能认出原本叫什么
  if (RESERVED_DEVICE.test(base)) base = `_${base}`
  return truncate(base, MAX_NAME_CODE_POINTS)
}

/**
 * 生成不与已有文件/已入队任务冲突的目标路径。
 * 是否「已占用」交给调用方判断（磁盘 + 数据库两个来源），这里保持纯逻辑、可单测。
 */
export function buildTargetPath(
  dir: string,
  base: string,
  ext: string,
  isTaken: (fullPath: string) => boolean
): string {
  const normalizedDir = normalizePath(dir)
  const extPart = ext ? `.${ext}` : ''
  // 预留「 (999)」的位置，避免截断后追加序号又顶破 260
  const suffixBudget = ' (999)'.length
  const allowed = MAX_PATH - (normalizedDir.length + 1) - extPart.length - suffixBudget
  const name = truncate(base, Math.max(1, Math.min(MAX_NAME_CODE_POINTS, allowed)))

  for (let index = 0; index < MAX_DEDUPE_ATTEMPTS; index += 1) {
    const fileName = index === 0 ? `${name}${extPart}` : `${name} (${index})${extPart}`
    // 固定用 win32 规则拼接：本应用只做 Windows，测试结果也不受运行平台影响
    const fullPath = path.win32.join(normalizedDir, fileName)
    if (!isTaken(fullPath)) return fullPath
  }
  throw makeError('E_UNKNOWN', `no available file name for ${base}`)
}

function truncate(value: string, max: number): string {
  // 按码点切，不把 emoji 或生僻字劈成半个代理对
  const chars = Array.from(value)
  return chars.length <= max ? value : chars.slice(0, max).join('')
}

// 控制字符（含换行、制表符）在 Windows 文件名里同样非法；单列出来避免正则里的控制字符告警
function isIllegal(char: string): boolean {
  return ILLEGAL_CHARS.has(char) || char.charCodeAt(0) < 32
}
