import fs from 'node:fs'
import { makeError } from '@shared/errors'
import type { ClearResult, ClearScope } from '@shared/types'
import { getDb } from '../db'
import type { DownloadEngine } from '../download/engine'
import { log } from '../log'

const SCOPES: readonly ClearScope[] = ['favorites', 'downloads', 'settings', 'all']

/** 清空前的活动任务判定：这些状态可能还握着 `.part` 或正在写库 */
const ACTIVE_STATES = ['queued', 'downloading', 'paused', 'verifying'] as const

export interface ResetService {
  clearData(raw: unknown): Promise<ClearResult>
}

/**
 * 清空数据（§7.5-7）：只删库记录，不碰磁盘上的素材文件。
 * 下载记录删除时靠外键 ON DELETE SET NULL 自动把 local_files.download_id 置空，
 * 本地素材记录与文件本身都保留，用户仍能在「本地素材」里看到并打开它们。
 */
export function createResetService(deps: { engine: DownloadEngine }): ResetService {
  return {
    async clearData(raw) {
      const scope = readScope(raw)
      const db = getDb()
      const result: ClearResult = { favorites: 0, downloads: 0, settings: 0 }

      let targets: Array<{ id: string; target_path: string }> = []
      if (scope === 'downloads' || scope === 'all') {
        targets = db
          .prepare(
            `SELECT id, target_path FROM downloads
              WHERE state IN (${ACTIVE_STATES.map(() => '?').join(', ')})`
          )
          .all(...ACTIVE_STATES) as Array<{ id: string; target_path: string }>

        // 先把在跑的任务取消掉再删表：否则引擎收尾时还会去写已被删除的行
        for (const task of targets) {
          await deps.engine.stop(task.id, 'cancel')
        }
      }

      const write = db.transaction(() => {
        if (scope === 'favorites' || scope === 'all') {
          result.favorites = db.prepare('DELETE FROM favorites').run().changes
        }
        if (scope === 'downloads' || scope === 'all') {
          result.downloads = db.prepare('DELETE FROM downloads').run().changes
        }
        if (scope === 'settings' || scope === 'all') {
          // 个人设置包含已保存的 API Key；清空后需要用户重新填写，界面上会明确提示
          result.settings = db.prepare('DELETE FROM settings').run().changes
        }
      })
      write()

      // 记录删完后 `.part` 已经无主；§5.8 允许把应用临时文件物理删除
      for (const task of targets) removePart(task.target_path)

      log.info(
        `data cleared scope=${scope} favorites=${result.favorites} downloads=${result.downloads} settings=${result.settings}`
      )
      return result
    }
  }
}

function readScope(raw: unknown): ClearScope {
  const value =
    typeof raw === 'object' && raw !== null ? (raw as { scope?: unknown }).scope : undefined
  if (typeof value !== 'string' || !SCOPES.includes(value as ClearScope)) {
    throw makeError('E_INVALID_ARG', 'scope')
  }
  return value as ClearScope
}

function removePart(targetPath: string): void {
  try {
    fs.unlinkSync(`${targetPath}.part`)
  } catch {
    // 不存在或已被清理都算正常
  }
}
