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

/**
 * V0.2 第一批只加下达/本地素材两张表：
 * - `target_path` 加 UNIQUE，靠数据库兜住「同名入队竞态」，不靠调用方自觉；
 * - 外键一律 SET NULL，清下载历史时不能把已下载的文件记录一起带走（§5.2）。
 * `received_bytes` 只是缓存，启动恢复始终以磁盘 `.part` 大小为准（§5.4）。
 */
const SCHEMA_V2 = `
CREATE TABLE downloads (
  id TEXT PRIMARY KEY,
  asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (
    state IN ('queued', 'downloading', 'paused', 'verifying', 'completed', 'failed', 'canceled', 'quarantined')
  ),
  target_path TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  total_bytes INTEGER,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  last_modified TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_downloads_state ON downloads(state);
CREATE INDEX idx_downloads_order ON downloads(sort_order, created_at);

CREATE TABLE local_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  download_id TEXT REFERENCES downloads(id) ON DELETE SET NULL,
  path TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL CHECK (status IN ('present', 'missing', 'quarantined')),
  size_bytes INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_local_files_status ON local_files(status);
`

/**
 * V0.2 安全批次：隔离区需要独立记录「为什么被隔离」，而 local_files 只表达文件现状。
 * 不把原因塞进 downloads.error_code：错误码是枚举，承担不了可读原因（§4.1 要求判定必须给原因）。
 */
const SCHEMA_V3 = `
CREATE TABLE quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  download_id TEXT REFERENCES downloads(id) ON DELETE SET NULL,
  path TEXT NOT NULL UNIQUE COLLATE NOCASE,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_quarantine_created ON quarantine(created_at);
`

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(SCHEMA_V1)
    }
  },
  {
    version: 2,
    up: (db) => {
      db.exec(SCHEMA_V2)
    }
  },
  {
    version: 3,
    up: (db) => {
      db.exec(SCHEMA_V3)
    }
  }
]

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0
