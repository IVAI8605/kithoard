import type { ErrorCode } from '@shared/errors'
import type { DownloadState } from '@shared/types'

/**
 * §5.4 崩溃恢复表。
 * 磁盘是唯一真相，库里的状态只是线索；因此本函数只接收「磁盘上看到了什么」，
 * 不读库、不写库，方便把全部分支穷举成单测。启动恢复的接线在后续批次完成。
 */

export interface RecoveryFacts {
  dbState: DownloadState
  /** `.part` 的实际大小；null 表示磁盘上不存在 */
  partBytes: number | null
  /** 目标文件三态：不存在 / 校验通过 / 校验失败 */
  targetState: 'absent' | 'valid' | 'invalid'
  /** 隔离区里是否还有该任务的文件 */
  quarantineExists: boolean
}

export interface RecoveryResult {
  state: DownloadState
  /** 校正后的已下载字节；未给出时沿用库中旧值 */
  receivedBytes?: number
  errorCode?: ErrorCode
  /** rename 已完成但没来得及写 local_files，需要补登 */
  registerLocalFile?: boolean
  /** 目标文件已丢失，需要把 local_files 标成 missing */
  markLocalMissing?: boolean
  /** 需要弹窗询问用户是否恢复（不自动开始） */
  needsPrompt?: boolean
}

export function decideRecovery(facts: RecoveryFacts): RecoveryResult {
  const { dbState, partBytes, targetState, quarantineExists } = facts

  switch (dbState) {
    case 'queued':
      // 排队任务一律不自动开始：用户可能关机前刚点了一堆，重新开机就猛下会吓到人
      return { state: 'queued', needsPrompt: true }

    case 'downloading':
      if (partBytes !== null) return { state: 'paused', receivedBytes: partBytes }
      return { state: 'failed', errorCode: 'E_TEMP_MISSING' }

    case 'paused':
      if (partBytes !== null) return { state: 'paused', receivedBytes: partBytes }
      return { state: 'failed', errorCode: 'E_TEMP_MISSING' }

    case 'verifying':
      // 先看目标文件：rename 成功但插库前崩溃，属于可修复的「已完成」
      if (targetState === 'valid') return { state: 'completed', registerLocalFile: true }
      if (targetState === 'invalid') return { state: 'failed', errorCode: 'E_VERIFY_FAILED' }
      if (partBytes !== null) return { state: 'paused', receivedBytes: partBytes }
      return { state: 'failed', errorCode: 'E_TEMP_MISSING' }

    case 'quarantined':
      if (quarantineExists) return { state: 'quarantined' }
      // 隔离区文件不在了、目标文件已就位：说明用户在外面确认恢复了
      if (targetState === 'valid') return { state: 'completed', registerLocalFile: true }
      // 目标文件存在但校验不过，或两边都没有：维持隔离态等用户处理，不擅自判定完成
      return { state: 'quarantined' }

    case 'completed':
      return targetState === 'absent'
        ? { state: 'completed', markLocalMissing: true }
        : { state: 'completed' }

    case 'failed':
    case 'canceled':
      return { state: dbState }
  }
}
