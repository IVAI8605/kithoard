import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { getDb } from '../db'
import { log } from '../log'
import { countPlaintextApiKeys, migratePlaintextApiKeys } from './key-migration'

export interface KeyMigrationResult {
  migrated: number
  /** 迁移前的留档路径；没有明文或未执行时是 null */
  archivePath: string | null
}

/** 留档名带本地时间，同一分钟内多次启动不会互相覆盖 */
function archiveName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `kithoard.db.pre-key-migration-${now.getFullYear()}${pad(now.getMonth() + 1)}` +
    `${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  )
}

/**
 * 启动序列里执行一次：把历史 plain: Key 迁移为系统加密的 enc:。
 *
 * 顺序不能换：先 checkpoint 再留档（否则 WAL 里的明文不在留档里）→ 事务改写 →
 * checkpoint + VACUUM 清掉 WAL 与空闲页里的旧明文 → 强制刷新 .bak（否则备份仍是明文）。
 * 任何一步失败都不阻断启动：留档失败就不改主库；清理与备份刷新失败只记 WARN。
 */
export function runKeyMigration(userDataDir: string): KeyMigrationResult {
  if (!isEncryptionAvailable()) {
    // 本机不支持加密时保持现状：设置页已明确提示明文风险，迁移只会白改
    log.warn('key migration skipped: safeStorage unavailable')
    return { migrated: 0, archivePath: null }
  }

  const db = getDb()
  if (countPlaintextApiKeys(db) === 0) return { migrated: 0, archivePath: null }

  const file = path.join(userDataDir, 'kithoard.db')
  try {
    // 先把 WAL 落盘，留档才是完整的迁移前状态
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch (error) {
    log.warn(`key migration checkpoint failed: ${describe(error)}`)
  }

  const archivePath = path.join(userDataDir, archiveName(new Date()))
  try {
    fs.copyFileSync(file, archivePath)
  } catch (error) {
    // 没有退路的迁移不做：留档失败就保持原样，下次启动还会再试
    log.error(`key migration archive failed: ${describe(error)}`)
    return { migrated: 0, archivePath: null }
  }

  let migrated = 0
  try {
    migrated = migratePlaintextApiKeys(db, (plain) =>
      safeStorage.encryptString(plain).toString('base64')
    )
  } catch (error) {
    log.error(`key migration failed: ${describe(error)}`)
    return { migrated: 0, archivePath }
  }

  // VACUUM 重建库文件，顺带清掉 WAL 与 freelist 里可能残留的旧明文；失败只影响残留清理。
  // 必须走 exec：better-sqlite3 的 pragma('vacuum') 是空操作，不会真的重建文件。
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.exec('VACUUM')
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch (error) {
    log.warn(`key migration cleanup failed: ${describe(error)}`)
  }

  try {
    fs.copyFileSync(file, `${file}.bak`)
  } catch (error) {
    log.warn(`key migration backup refresh failed: ${describe(error)}`)
  }

  log.info(`key migration done count=${migrated}`)
  return { migrated, archivePath }
}

function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
