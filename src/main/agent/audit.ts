import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentAuditEntry } from '@shared/agent'
import { log } from '../log'

/** 单文件上限：超过就改名留档，不删除。agent 调用量小，5 MB 够跑很久 */
const MAX_AUDIT_BYTES = 5 * 1024 * 1024

export interface AgentAudit {
  /** 追加一条审计；写失败只记日志，不影响业务结果 */
  write(entry: AgentAuditEntry): void
  /** 读最近 N 条，供设置页展示 */
  recent(limit: number): AgentAuditEntry[]
  /** 审计文件绝对路径，供「导出/打开位置」使用 */
  filePath(): string
  /** 参数摘要：只留哈希前 16 位，审计不落原文，避免把路径清单以外的内容写进日志 */
  argsHash(args: unknown): string
}

export function createAgentAudit(userDataDir: string): AgentAudit {
  const file = path.join(userDataDir, 'agent-audit.jsonl')

  function rotateIfNeeded(): void {
    try {
      const stat = fs.statSync(file)
      if (stat.size <= MAX_AUDIT_BYTES) return
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
      // 改名而不是删除：审计是凭证，历史必须留档可查
      fs.renameSync(file, path.join(userDataDir, `agent-audit.${stamp}.jsonl`))
    } catch {
      // 文件还不存在或改名失败都不影响后续 append
    }
  }

  return {
    write(entry) {
      try {
        rotateIfNeeded()
        fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
      } catch (error) {
        log.warn(
          `agent audit write failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    },

    recent(limit) {
      const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50
      try {
        const lines = fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => line.trim().length > 0)
        const out: AgentAuditEntry[] = []
        for (const line of lines.slice(-count)) {
          try {
            out.push(JSON.parse(line) as AgentAuditEntry)
          } catch {
            // 单行损坏（例如上次写到一半断电）跳过，不能让整份审计读不出来
          }
        }
        return out
      } catch {
        return []
      }
    },

    filePath() {
      return file
    },

    argsHash(args) {
      return crypto
        .createHash('sha256')
        .update(JSON.stringify(args ?? null))
        .digest('hex')
        .slice(0, 16)
    }
  }
}
