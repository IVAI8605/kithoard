import { ERROR_MESSAGES, type ErrorCode } from '@shared/errors'
import type { DownloadState } from '@shared/types'

/**
 * 下载管理页的展示规则集中在这里，保持纯函数：
 * 状态文案、可做的操作、进度百分比都能直接单测，页面组件不掺业务判断。
 */

export type StateTone = 'queued' | 'active' | 'paused' | 'done' | 'failed' | 'risk'

const LABELS: Record<DownloadState, string> = {
  queued: '排队中',
  downloading: '下载中',
  paused: '已暂停',
  verifying: '校验中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
  quarantined: '已隔离'
}

const TONES: Record<DownloadState, StateTone> = {
  queued: 'queued',
  downloading: 'active',
  paused: 'paused',
  verifying: 'active',
  completed: 'done',
  failed: 'failed',
  canceled: 'done',
  quarantined: 'risk'
}

export function stateLabel(state: DownloadState): string {
  return LABELS[state]
}

export function stateTone(state: DownloadState): StateTone {
  return TONES[state]
}

export interface TaskActions {
  pause: boolean
  resume: boolean
  retry: boolean
  cancel: boolean
}

/** 与 §5.3 状态机保持一致：界面上只给当前状态真正合法的按钮，点了不会被主进程拒绝 */
export function actionsOf(state: DownloadState): TaskActions {
  return {
    pause: state === 'downloading',
    resume: state === 'paused',
    retry: state === 'failed',
    cancel:
      state === 'queued' ||
      state === 'downloading' ||
      state === 'paused' ||
      state === 'verifying' ||
      state === 'failed'
  }
}

/** 终态里只有 completed/canceled 不再需要操作；failed 仍要等用户决定重试或取消 */
export function isFinished(state: DownloadState): boolean {
  return state === 'completed' || state === 'canceled'
}

/** 总大小未知时返回 null，界面不画百分比，只显示已下载字节（§5.5 chunked 分支） */
export function progressPercent(received: number, total: number | null): number | null {
  if (total === null || total <= 0 || !Number.isFinite(received)) return null
  return Math.min(100, Math.max(0, Math.round((received / total) * 100)))
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatProgress(received: number, total: number | null): string {
  if (total === null || total <= 0) return `已下载 ${formatBytes(received)}`
  return `${formatBytes(received)} / ${formatBytes(total)}`
}

/** 错误码转中文；未知码原样显示，方便用户反馈时贴给开发者 */
export function errorText(code: string | null): string | null {
  if (!code) return null
  return ERROR_MESSAGES[code as ErrorCode] ?? code
}

/** 渲染层拿不到 node:path，这里只做字符串切分，够用于显示文件名 */
export function fileNameOf(fullPath: string): string {
  const parts = fullPath.split(/[\\/]/)
  return parts[parts.length - 1] || fullPath
}

/**
 * 把 fromId 移到 toId 的位置。
 * 用「先删后插」而不是交换：拖拽语义是插入到目标位置，交换会让相邻两项的顺序看起来乱跳。
 */
export function moveTask(ids: string[], fromId: string, toId: string): string[] {
  const from = ids.indexOf(fromId)
  const to = ids.indexOf(toId)
  if (from < 0 || to < 0 || from === to) return ids
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, fromId)
  return next
}
