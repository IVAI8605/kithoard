import { READABLE_SETTINGS, WRITABLE_SETTINGS } from '@shared/channels'
import { makeError } from '@shared/errors'
import {
  getEnabledSources,
  hasApiKey,
  isKeyStorageEncrypted,
  setApiKey,
  setEnabledSources
} from '../settings'
import type { SourceRegistry } from '../sources/registry'

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
}

function readKey(raw: unknown, allowed: readonly string[]): string {
  const key = asRecord(raw).key
  if (typeof key !== 'string' || !allowed.includes(key)) throw makeError('E_INVALID_ARG', 'key')
  return key
}

export interface SettingsService {
  read(raw: unknown): unknown
  write(raw: unknown): { ok: true }
}

/**
 * 设置读写走白名单而不是全表放开：秘密项只能"问有没有"，不能"取出来"，
 * 这样界面与未来的 agent 网关都不会把 Key 带出主进程。
 */
export function createSettingsService(deps: { registry: SourceRegistry }): SettingsService {
  return {
    read(raw) {
      const key = readKey(raw, READABLE_SETTINGS)
      if (key === 'source.enabled') return getEnabledSources()
      if (key === 'source.apiKey.pixabay') return hasApiKey('pixabay')
      // app.keyStorage：让设置面板能如实提示「明文降级」，而不是假装已加密
      return isKeyStorageEncrypted() ? 'encrypted' : 'plaintext'
    },

    write(raw) {
      const record = asRecord(raw)
      const key = readKey(record, WRITABLE_SETTINGS)
      const value = record.value

      if (key === 'source.apiKey.pixabay') {
        if (typeof value !== 'string' || value.length > 200) {
          throw makeError('E_INVALID_ARG', 'value')
        }
        setApiKey('pixabay', value)
        return { ok: true }
      }

      const knownIds = new Set(deps.registry.all().map(({ adapter }) => adapter.id))
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        !value.every((id): id is string => typeof id === 'string' && knownIds.has(id))
      ) {
        throw makeError('E_INVALID_ARG', 'source.enabled')
      }
      setEnabledSources(value)
      return { ok: true }
    }
  }
}
