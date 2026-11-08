export type ErrorCode =
  | 'E_INVALID_ARG'
  | 'E_URL_FORBIDDEN'
  | 'E_DIR_FORBIDDEN'
  | 'E_NETWORK'
  | 'E_RATE_LIMITED'
  | 'E_SOURCE_DOWN'
  | 'E_AUTH_REQUIRED'
  | 'E_LICENSE_UNKNOWN'
  | 'E_LICENSE_PAID'
  | 'E_UNSUPPORTED'
  | 'E_DISK_FULL'
  | 'E_DIR_UNWRITABLE'
  | 'E_VERIFY_FAILED'
  | 'E_TEMP_MISSING'
  | 'E_FILE_IN_USE'
  | 'E_FFMPEG_MISSING'
  | 'E_MEDIA_UNSUPPORTED'
  | 'E_RISK_FILE'
  | 'E_RESTORE_INVALID'
  | 'E_DB_CORRUPT'
  | 'E_UNKNOWN'

export interface AppError {
  code: ErrorCode
  message: string
  retryable: boolean
  /** 英文原始报错只放这里，界面默认折叠 */
  detail?: string
}

export type Envelope<T> = { ok: true; data: T } | { ok: false; error: AppError }

/** 面向用户的中文文案；英文异常不进 message */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  E_INVALID_ARG: '请求参数不合法',
  E_URL_FORBIDDEN: '这个地址不允许在应用内打开',
  E_DIR_FORBIDDEN: '这个目录不允许操作',
  E_NETWORK: '网络连接失败，请检查网络后重试',
  E_RATE_LIMITED: '请求太频繁，请稍后再试',
  E_SOURCE_DOWN: '该素材来源暂时不可用',
  E_AUTH_REQUIRED: '尚未配置该来源的 API Key',
  E_LICENSE_UNKNOWN: '该素材授权状态不明，已禁止下载',
  E_LICENSE_PAID: '该素材需要付费或授权，已禁止下载',
  E_UNSUPPORTED: '当前版本暂不支持此操作',
  E_DISK_FULL: '磁盘空间不足',
  E_DIR_UNWRITABLE: '目标目录不可写',
  E_VERIFY_FAILED: '文件校验未通过',
  E_TEMP_MISSING: '临时文件已丢失，请重新下载',
  E_FILE_IN_USE: '文件正被其他程序占用',
  E_FFMPEG_MISSING: '未找到音视频处理组件',
  E_MEDIA_UNSUPPORTED: '不支持的媒体格式',
  E_RISK_FILE: '文件存在风险，已移入隔离区',
  E_RESTORE_INVALID: '备份文件不合法',
  E_DB_CORRUPT: '本地数据库损坏',
  E_UNKNOWN: '出现未知错误，请重试'
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'E_NETWORK',
  'E_RATE_LIMITED',
  'E_SOURCE_DOWN',
  'E_UNKNOWN'
])

export function makeError(code: ErrorCode, detail?: string): AppError {
  return {
    code,
    message: ERROR_MESSAGES[code],
    retryable: RETRYABLE.has(code),
    ...(detail ? { detail } : {})
  }
}

export function ok<T>(data: T): Envelope<T> {
  return { ok: true, data }
}

export function fail<T = never>(code: ErrorCode, detail?: string): Envelope<T> {
  return { ok: false, error: makeError(code, detail) }
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    typeof (value as AppError).code === 'string'
  )
}
