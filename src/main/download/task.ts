import { makeError } from '@shared/errors'
import type { DownloadState } from '@shared/types'

/**
 * 状态机事件。名字贴近「发生了什么」而不是「要干什么」，
 * 这样将来 agent 网关复用同一套迁移时，不需要再翻译一遍术语。
 */
export type DownloadEvent =
  | 'enqueue'
  | 'start'
  | 'pause'
  | 'resume'
  | 'fail'
  | 'retry'
  | 'verify'
  | 'verify-pass'
  | 'verify-fail'
  | 'quarantine'
  | 'restore'
  | 'abandon'
  | 'cancel'

type TransitionTable = Record<DownloadState, Partial<Record<DownloadEvent, DownloadState>>>

/**
 * 与版本规划 §5.3 迁移表逐行对应。写成整张表而不是散落的 if：
 * 表就是契约，单测可以按表穷举，漏一条迁移会直接让测试变红。
 * 未列出的组合一律视为非法，不做「兜底放行」——状态错乱比报错更难查。
 */
const TRANSITIONS: TransitionTable = {
  queued: { start: 'downloading', cancel: 'canceled' },
  downloading: { pause: 'paused', fail: 'failed', verify: 'verifying', cancel: 'canceled' },
  paused: { resume: 'queued', cancel: 'canceled' },
  failed: { retry: 'queued', cancel: 'canceled' },
  verifying: {
    'verify-pass': 'completed',
    'verify-fail': 'failed',
    quarantine: 'quarantined',
    cancel: 'canceled'
  },
  // 用户确认恢复与放弃各走一条；cancel 与 abandon 结果相同，保留两个名字是为了让调用方语义清楚
  quarantined: { restore: 'completed', abandon: 'canceled', cancel: 'canceled' },
  completed: {},
  canceled: {}
}

/** 进入这两个状态后不再有自动动作；completed 之后只剩本地素材页的文件操作 */
const TERMINAL: readonly DownloadState[] = ['completed', 'canceled']

export function isTerminal(state: DownloadState): boolean {
  return TERMINAL.includes(state)
}

/**
 * 计算下一状态；非法迁移直接抛出 E_INVALID_ARG。
 * 入参允许 null，表示「库里还不存在这条任务」，只有 enqueue 能从这里出发。
 */
export function nextState(from: DownloadState | null, event: DownloadEvent): DownloadState {
  if (from === null) {
    if (event === 'enqueue') return 'queued'
    throw makeError('E_INVALID_ARG', `download transition: null --${event}--> ?`)
  }
  const to = TRANSITIONS[from][event]
  if (!to) throw makeError('E_INVALID_ARG', `download transition: ${from} --${event}--> ?`)
  return to
}
