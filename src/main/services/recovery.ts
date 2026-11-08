import fs from 'node:fs'
import type { AssetType, DownloadState, RecoveryReport } from '@shared/types'
import { getDb } from '../db'
import { decideRecovery } from '../download/recovery'
import { judgeFile } from '../safety/magic'

/**
 * §5.4 启动恢复。
 * 只扫「未终态 + 隔离态」：completed 的文件巡检属于本地素材页，启动时全量 stat 会拖慢打开速度。
 * 决策仍交给纯函数 decideRecovery，本文只负责读磁盘事实与写库，方便恢复规则继续用单测穷举。
 */
const SCAN_STATES = ['queued', 'downloading', 'paused', 'verifying', 'quarantined'] as const

interface ScanRow {
  id: string
  asset_id: number | null
  asset_type: AssetType | null
  state: DownloadState
  target_path: string
  total_bytes: number | null
  received_bytes: number
}

export function runStartupRecovery(): RecoveryReport {
  const db = getDb()
  const placeholders = SCAN_STATES.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT d.id, d.asset_id, a.type AS asset_type, d.state, d.target_path,
              d.total_bytes, d.received_bytes
         FROM downloads d
         LEFT JOIN assets a ON a.id = d.asset_id
        WHERE d.state IN (${placeholders})
        ORDER BY d.sort_order, d.created_at`
    )
    .all(...SCAN_STATES) as ScanRow[]

  const report: RecoveryReport = {
    scanned: rows.length,
    corrected: 0,
    repaired: 0,
    failed: 0,
    pendingQueued: 0,
    quarantined: 0
  }

  const updateTask = db.prepare(
    'UPDATE downloads SET state = ?, received_bytes = ?, error_code = ?, updated_at = ? WHERE id = ?'
  )
  // path 已是 UNIQUE COLLATE NOCASE，补登时复用同一行而不是插第二条
  const upsertLocal = db.prepare(
    `INSERT INTO local_files (asset_id, download_id, path, status, size_bytes, created_at, updated_at)
     VALUES (?, ?, ?, 'present', ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       status = 'present',
       size_bytes = excluded.size_bytes,
       updated_at = excluded.updated_at`
  )
  const markMissing = db.prepare(
    `UPDATE local_files SET status = 'missing', updated_at = ? WHERE path = ? AND status = 'present'`
  )
  const quarantineOf = db.prepare('SELECT path FROM quarantine WHERE download_id = ?')

  const now = Date.now()
  // 一次事务包住全部校正：中途崩掉也不会出现「一半已改、一半没改」的半恢复状态
  db.transaction(() => {
    for (const row of rows) {
      const partBytes = statSize(`${row.target_path}.part`)
      const targetState = readTargetState(row.target_path, row.asset_type)
      const quarantineExists = (quarantineOf.all(row.id) as Array<{ path: string }>).some(
        (item) => statSize(item.path) !== null
      )

      const result = decideRecovery({
        dbState: row.state,
        partBytes,
        targetState,
        quarantineExists
      })
      const received = result.receivedBytes ?? row.received_bytes
      const changed =
        result.state !== row.state ||
        received !== row.received_bytes ||
        result.errorCode !== undefined

      if (changed) {
        // 只有进入 failed 才有 errorCode；其余情况写 NULL，避免旧错误码挂在新状态上
        updateTask.run(result.state, received, result.errorCode ?? null, now, row.id)
        report.corrected += 1
      }
      if (result.state === 'failed' && result.state !== row.state) report.failed += 1
      if (result.registerLocalFile && targetState === 'valid') {
        const size = statSize(row.target_path) ?? 0
        upsertLocal.run(row.asset_id, row.id, row.target_path, size, now, now)
        report.repaired += 1
      }
      if (result.markLocalMissing) markMissing.run(now, row.target_path)
      if (result.state === 'queued') report.pendingQueued += 1
      if (result.state === 'quarantined' && quarantineExists) report.quarantined += 1
    }
  })()

  return report
}

/** 目标文件三态；只有「存在」还不够，必须内容也对得上才算 valid */
function readTargetState(
  filePath: string,
  type: AssetType | null
): 'absent' | 'valid' | 'invalid' {
  if (statSize(filePath) === null) return 'absent'
  // 素材元数据被删后无法判魔数；引擎只会在校验通过后才 rename，存在即可信
  if (type === null) return 'valid'
  const head = readHead(filePath)
  if (head === null) return 'invalid'
  return judgeFile(head, type).ok ? 'valid' : 'invalid'
}

/** 只读 64 字节；读取失败按「校验不过」处理，不擅自当成有效文件 */
function readHead(filePath: string): Uint8Array | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(64)
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
    return read === 0 ? null : buffer.subarray(0, read)
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

function statSize(filePath: string): number | null {
  try {
    const info = fs.statSync(filePath)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}
