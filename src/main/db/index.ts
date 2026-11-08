import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { makeError } from '@shared/errors'
import { log } from '../log'
import { LATEST_VERSION, MIGRATIONS } from './migrations'

// 全应用唯一写库入口：其他模块只能通过这里拿连接，避免多处直接打开文件
let instance: Database.Database | null = null

/** §7.8-7：启动成功后刷新 .bak，最长间隔一周 */
const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

export function openDatabase(userDataDir: string): Database.Database {
  fs.mkdirSync(userDataDir, { recursive: true })
  const file = path.join(userDataDir, 'kithoard.db')
  // 先判断是否已有库：首次建库不该产生一份空 .bak
  const existed = fs.existsSync(file)
  const db = openOrRecover(file)

  migrate(db, file, existed)
  refreshBackup(db, file)
  instance = db
  return db
}

/**
 * 打不开或完整性检查不通过时，优先从 `.bak` 恢复（§7.8-7）。
 * 损坏库改名留档而不是物理删除，用户仍可在数据目录里找到它。
 */
function openOrRecover(file: string): Database.Database {
  try {
    return openChecked(file)
  } catch (firstError) {
    const backup = `${file}.bak`
    if (!fs.existsSync(backup)) {
      throw makeError(
        'E_DB_CORRUPT',
        firstError instanceof Error ? firstError.message : String(firstError)
      )
    }

    const stamp = Date.now()
    const detail = firstError instanceof Error ? firstError.message : String(firstError)
    log.warn(`db corrupt, restoring from .bak: ${detail}`)
    safeRename(file, `${file}.corrupt-${stamp}`)
    // WAL/SHM 属于同一份损坏库，一并改名，避免干扰恢复后的新库
    safeRename(`${file}-wal`, `${file}.corrupt-${stamp}.wal`)
    safeRename(`${file}-shm`, `${file}.corrupt-${stamp}.shm`)
    fs.copyFileSync(backup, file)

    try {
      log.info('db restored from backup')
      return openChecked(file)
    } catch (secondError) {
      throw makeError(
        'E_DB_CORRUPT',
        secondError instanceof Error ? secondError.message : String(secondError)
      )
    }
  }
}

function openChecked(file: string): Database.Database {
  const db = new Database(file)
  try {
    // WAL + NORMAL：强杀/断电下优先保证库能打开，代价是最后一次提交可能回滚
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    const check = db.pragma('quick_check', { simple: true })
    if (check !== 'ok') throw new Error(`quick_check: ${String(check)}`)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function safeRename(from: string, to: string): void {
  try {
    if (fs.existsSync(from)) fs.renameSync(from, to)
  } catch {
    // 改名失败不阻断恢复：后面 copyFile 仍会尝试覆盖主库
  }
}

function migrate(db: Database.Database, file: string, existed: boolean): void {
  const current = Number(db.pragma('user_version', { simple: true }))
  if (current >= LATEST_VERSION) return

  // 升级已有库前强制留一份 .bak；失败时用户至少还有上一次能打开的库
  if (existed) {
    fs.copyFileSync(file, `${file}.bak`)
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    const run = db.transaction(() => {
      migration.up(db)
      db.pragma(`user_version = ${migration.version}`)
    })
    run()
  }
}

/** 启动成功后刷新 .bak；先 checkpoint，确保 WAL 里的已提交数据进入主库文件 */
function refreshBackup(db: Database.Database, file: string): void {
  try {
    const backup = `${file}.bak`
    const fresh =
      fs.existsSync(backup) && Date.now() - fs.statSync(backup).mtimeMs < BACKUP_INTERVAL_MS
    if (fresh) return
    db.pragma('wal_checkpoint(TRUNCATE)')
    fs.copyFileSync(file, backup)
  } catch {
    // 备份失败只影响下次恢复能力，不影响本次启动
  }
}

export function getDb(): Database.Database {
  if (!instance) throw new Error('DB_NOT_OPEN')
  return instance
}

export function closeDatabase(): void {
  instance?.close()
  instance = null
}
