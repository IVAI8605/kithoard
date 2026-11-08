import { describe, expect, it } from 'vitest'
import type { DownloadState } from '../src/shared/types'
import { isTerminal, nextState, type DownloadEvent } from '../src/main/download/task'

const STATES: DownloadState[] = [
  'queued',
  'downloading',
  'paused',
  'verifying',
  'completed',
  'failed',
  'canceled',
  'quarantined'
]

const EVENTS: DownloadEvent[] = [
  'enqueue',
  'start',
  'pause',
  'resume',
  'fail',
  'retry',
  'verify',
  'verify-pass',
  'verify-fail',
  'quarantine',
  'restore',
  'abandon',
  'cancel'
]

/** 期望值照抄版本规划 §5.3 的状态机表，任一侧改动都会让这组用例变红 */
const EXPECTED: Record<DownloadState, Partial<Record<DownloadEvent, DownloadState>>> = {
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
  quarantined: { restore: 'completed', abandon: 'canceled', cancel: 'canceled' },
  completed: {},
  canceled: {}
}

function errorCodeOf(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'NOT_APP_ERROR'
  }
}

describe('下载状态机', () => {
  it('全表的合法迁移与非法迁移都与 §5.3 一致', () => {
    for (const state of STATES) {
      for (const event of EVENTS) {
        const expected = EXPECTED[state][event]
        if (expected) {
          expect(nextState(state, event), `${state} --${event}-->`).toBe(expected)
        } else {
          expect(errorCodeOf(() => nextState(state, event)), `${state} --${event}-->`).toBe(
            'E_INVALID_ARG'
          )
        }
      }
    }
  })

  it('只有 completed / canceled 是终态，failed 仍可重试', () => {
    expect(STATES.filter((state) => isTerminal(state))).toEqual(['completed', 'canceled'])
  })

  it('入队只能从「任务不存在」出发，且停在 queued', () => {
    expect(nextState(null, 'enqueue')).toBe('queued')
    expect(errorCodeOf(() => nextState(null, 'start'))).toBe('E_INVALID_ARG')
    expect(errorCodeOf(() => nextState('queued', 'enqueue'))).toBe('E_INVALID_ARG')
  })

  it('除终态外，任何状态都能被用户取消', () => {
    for (const state of STATES.filter((candidate) => !isTerminal(candidate))) {
      expect(nextState(state, 'cancel'), state).toBe('canceled')
    }
    for (const state of STATES.filter((candidate) => isTerminal(candidate))) {
      expect(errorCodeOf(() => nextState(state, 'cancel')), state).toBe('E_INVALID_ARG')
    }
  })
})
