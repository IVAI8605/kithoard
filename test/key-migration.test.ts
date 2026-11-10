import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, openDatabase } from '../src/main/db/index'
import { countPlaintextApiKeys, migratePlaintextApiKeys } from '../src/main/security/key-migration'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithoard-key-migration-test-'))
let db: ReturnType<typeof openDatabase>

beforeEach(() => {
  db = openDatabase(dir)
  db.prepare('DELETE FROM settings').run()
})
afterEach(() => {
  closeDatabase()
})

function put(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

function valueOf(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

/** 用可预测的假加密，便于断言「没有二次加密」 */
function fakeEncrypt(plain: string): string {
  return plain.toUpperCase()
}

describe('明文 Key 迁移', () => {
  it('把 plain: 改写为 enc:，且只影响 source.apiKey. 前缀', () => {
    put('source.apiKey.pixabay', 'plain:secret-key')
    put('source.apiKey.pexels', 'plain:other-key')
    put('download.dir', 'plain:not-a-key')
    put('source.enabled', '["pixabay"]')

    const migrated = migratePlaintextApiKeys(db, fakeEncrypt)

    expect(migrated).toBe(2)
    expect(valueOf('source.apiKey.pixabay')).toBe('enc:SECRET-KEY')
    expect(valueOf('source.apiKey.pexels')).toBe('enc:OTHER-KEY')
    expect(valueOf('download.dir')).toBe('plain:not-a-key')
    expect(valueOf('source.enabled')).toBe('["pixabay"]')
  })

  it('幂等：重复执行计数为 0，已加密的值不再变化', () => {
    put('source.apiKey.pixabay', 'plain:secret-key')

    expect(migratePlaintextApiKeys(db, fakeEncrypt)).toBe(1)
    const first = valueOf('source.apiKey.pixabay')

    expect(migratePlaintextApiKeys(db, fakeEncrypt)).toBe(0)
    expect(valueOf('source.apiKey.pixabay')).toBe(first)
    // 不能出现 enc:enc: 的套娃
    expect(valueOf('source.apiKey.pixabay')).not.toContain('enc:enc:')
  })

  it('已经是 enc: 的行不会被再次包裹', () => {
    put('source.apiKey.pixabay', 'enc:existing-cipher')

    expect(migratePlaintextApiKeys(db, fakeEncrypt)).toBe(0)
    expect(valueOf('source.apiKey.pixabay')).toBe('enc:existing-cipher')
  })

  it('加密失败时整体回滚，库保持原样', () => {
    put('source.apiKey.pixabay', 'plain:secret-key')
    put('source.apiKey.pexels', 'plain:other-key')

    expect(() =>
      migratePlaintextApiKeys(db, () => {
        throw new Error('safeStorage unavailable')
      })
    ).toThrow('safeStorage unavailable')

    expect(valueOf('source.apiKey.pixabay')).toBe('plain:secret-key')
    expect(valueOf('source.apiKey.pexels')).toBe('plain:other-key')
    expect(countPlaintextApiKeys(db)).toBe(2)
  })

  it('没有明文时直接返回 0，不产生任何写入', () => {
    put('source.apiKey.pixabay', 'enc:existing-cipher')

    expect(migratePlaintextApiKeys(db, fakeEncrypt)).toBe(0)
    expect(countPlaintextApiKeys(db)).toBe(0)
  })
})
