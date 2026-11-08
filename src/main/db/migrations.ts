import type Database from 'better-sqlite3'

export interface Migration {
  version: number
  up: (db: Database.Database) => void
}

/**
 * V0.1 只建搜索闭环需要的三张表；下载/收藏/本地素材表按版本规划在后续版本追加。
 * 用 PRAGMA user_version 做版本号，不引入第二套 schema_meta 状态源。
 */
const SCHEMA_V1 = `
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('image', 'video', 'audio', 'font', 'template')),
  title TEXT NOT NULL,
  thumb_url TEXT,
  preview_url TEXT,
  page_url TEXT,
  width INTEGER,
  height INTEGER,
  duration_sec REAL,
  size_bytes INTEGER,
  license TEXT NOT NULL CHECK (license IN ('free', 'paid', 'unknown')),
  tags TEXT,
  fetched_at INTEGER NOT NULL,
  UNIQUE (source_id, remote_id)
);

CREATE INDEX idx_assets_type ON assets(type);
CREATE INDEX idx_assets_source ON assets(source_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(SCHEMA_V1)
    }
  }
]

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0
