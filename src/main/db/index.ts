import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { LATEST_VERSION, MIGRATIONS } from './migrations'

// 全应用唯一写库入口：其他模块只能通过这里拿连接，避免多处直接打开文件
let instance: Database.Database | null = null

export function openDatabase(userDataDir: string): Database.Database {
  fs.mkdirSync(userDataDir, { recursive: true })
  const file = path.join(userDataDir, 'kithoard.db')
  // 先判断是否已有库：首次建库不该产生一份空 .bak
  const existed = fs.existsSync(file)
  const db = new Database(file)

  // WAL + NORMAL：强杀/断电下优先保证库能打开，代价是最后一次提交可能回滚
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  migrate(db, file, existed)
  instance = db
  return db
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

export function getDb(): Database.Database {
  if (!instance) throw new Error('DB_NOT_OPEN')
  return instance
}

export function closeDatabase(): void {
  instance?.close()
  instance = null
}
