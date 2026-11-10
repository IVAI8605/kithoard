import { safeStorage } from 'electron'
import { getDb } from './db'
import { log } from './log'

const API_KEY_PREFIX = 'source.apiKey.'

function readRaw(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

function writeRaw(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}

export function isKeyStorageEncrypted(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * Key 用 safeStorage（Windows 走 DPAPI）加密后存 base64。
 * 环境不支持时降级明文，并在设置里显式标注，绝不假装已加密。
 */
export function setApiKey(sourceId: string, value: string): void {
  const key = `${API_KEY_PREFIX}${sourceId}`
  const trimmed = value.trim()
  const encrypted = isKeyStorageEncrypted()
  if (!trimmed) {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(key)
    log.info(`key cleared source=${sourceId}`)
    return
  }
  if (encrypted) {
    writeRaw(key, `enc:${safeStorage.encryptString(trimmed).toString('base64')}`)
  } else {
    writeRaw(key, `plain:${trimmed}`)
  }
  // 只记形态不记值：下次再出现明文降级时能直接定位，不必回查历史数据
  log.info(`key storage=${encrypted ? 'encrypted' : 'plaintext'} source=${sourceId}`)
}

export function getApiKey(sourceId: string): string {
  const raw = readRaw(`${API_KEY_PREFIX}${sourceId}`)
  if (!raw) return ''
  if (raw.startsWith('plain:')) return raw.slice('plain:'.length)
  if (!raw.startsWith('enc:')) return ''
  try {
    return safeStorage.decryptString(Buffer.from(raw.slice('enc:'.length), 'base64'))
  } catch {
    // 换机或换 Windows 用户后 DPAPI 解不开：坏值保留，由用户重填时自然覆盖，不自动删
    log.warn(`api key undecryptable source=${sourceId}`)
    return ''
  }
}

export function hasApiKey(sourceId: string): boolean {
  return getApiKey(sourceId).length > 0
}

/**
 * 库里是否存过 Key（不管能不能解开）。
 * 用来区分「没配过」与「配过但解不开」——后者要提示用户重填，而不是显示「未配置」。
 */
export function hasStoredApiKey(sourceId: string): boolean {
  return readRaw(`${API_KEY_PREFIX}${sourceId}`) !== null
}

export function getEnabledSources(): string[] {
  const raw = readRaw('source.enabled')
  if (!raw) return ['pixabay']
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed.length > 0 ? (parsed as string[]) : ['pixabay']
    }
  } catch {
    // 配置坏了回到默认源，不让界面因为一行坏 JSON 启动不了
  }
  return ['pixabay']
}

export function setEnabledSources(ids: string[]): void {
  writeRaw('source.enabled', JSON.stringify(ids))
}

export function getPlainSetting(key: string): string | null {
  return readRaw(key)
}

export function setPlainSetting(key: string, value: string): void {
  writeRaw(key, value)
}
