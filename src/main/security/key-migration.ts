import type Database from 'better-sqlite3'

export const API_KEY_PREFIX = 'source.apiKey.'
export const PLAINTEXT_PREFIX = 'plain:'
export const ENCRYPTED_PREFIX = 'enc:'

/**
 * 把 settings 表里 source.apiKey.% 的 plain: 值改写为 enc:。
 *
 * 幂等是核心：只命中 plain: 前缀，已经是 enc: 的行不会被再次包裹，
 * 重复启动时查不到行、计数为 0，不会出现 enc:enc: 的套娃。
 *
 * 单独成纯函数、由调用方注入加密实现，是为了不把 Electron 拉进单测；
 * 整个改写放在一个事务里，任何一步失败都回滚，库保持原样。
 */
export function migratePlaintextApiKeys(
  db: Database.Database,
  encrypt: (plain: string) => string
): number {
  const rows = db
    .prepare(
      `SELECT key, value FROM settings
        WHERE key LIKE ? AND value LIKE ?`
    )
    .all(`${API_KEY_PREFIX}%`, `${PLAINTEXT_PREFIX}%`) as Array<{ key: string; value: string }>
  if (rows.length === 0) return 0

  const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?')
  const run = db.transaction(() => {
    for (const row of rows) {
      update.run(`${ENCRYPTED_PREFIX}${encrypt(row.value.slice(PLAINTEXT_PREFIX.length))}`, row.key)
    }
  })
  run()
  return rows.length
}

/** 库里还有没有明文 Key；启动装配用它决定要不要留档与清理 */
export function countPlaintextApiKeys(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS value FROM settings
        WHERE key LIKE ? AND value LIKE ?`
    )
    .get(`${API_KEY_PREFIX}%`, `${PLAINTEXT_PREFIX}%`) as { value: number }
  return row.value
}
