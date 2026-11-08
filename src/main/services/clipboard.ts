import { clipboard } from 'electron'
import { makeError } from '@shared/errors'

export interface ClipboardService {
  /** 只接受 http(s) 链接：剪贴板是全局共享的，不该被写成任意脚本或本地路径 */
  writeExternalLink(raw: unknown): { ok: true }
}

export function createClipboardService(): ClipboardService {
  return {
    writeExternalLink(raw) {
      const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
      const text = record.text
      if (typeof text !== 'string' || text.length === 0 || text.length > 2000) {
        throw makeError('E_INVALID_ARG', 'text')
      }
      if (!/^https?:\/\//i.test(text)) throw makeError('E_URL_FORBIDDEN')
      clipboard.writeText(text)
      return { ok: true }
    }
  }
}
