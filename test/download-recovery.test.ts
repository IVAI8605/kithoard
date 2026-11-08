import { describe, expect, it } from 'vitest'
import { decideRecovery, type RecoveryFacts } from '../src/main/download/recovery'

function facts(overrides: Partial<RecoveryFacts>): RecoveryFacts {
  return {
    dbState: 'downloading',
    partBytes: null,
    targetState: 'absent',
    quarantineExists: false,
    ...overrides
  }
}

describe('崩溃恢复表', () => {
  it('queued：保持排队并询问，不自动开始', () => {
    expect(decideRecovery(facts({ dbState: 'queued' }))).toEqual({
      state: 'queued',
      needsPrompt: true
    })
  })

  it('downloading 且 .part 存在：回 paused 并校正字节', () => {
    expect(decideRecovery(facts({ dbState: 'downloading', partBytes: 123 }))).toEqual({
      state: 'paused',
      receivedBytes: 123
    })
  })

  it('downloading 且 .part 丢失：失败并提示重下', () => {
    expect(decideRecovery(facts({ dbState: 'downloading', partBytes: null }))).toEqual({
      state: 'failed',
      errorCode: 'E_TEMP_MISSING'
    })
  })

  it('paused 且 .part 存在：保持暂停并校正字节', () => {
    expect(decideRecovery(facts({ dbState: 'paused', partBytes: 456 }))).toEqual({
      state: 'paused',
      receivedBytes: 456
    })
  })

  it('paused 且 .part 丢失：失败', () => {
    expect(decideRecovery(facts({ dbState: 'paused', partBytes: null }))).toEqual({
      state: 'failed',
      errorCode: 'E_TEMP_MISSING'
    })
  })

  it('verifying 且目标文件校验通过：补登本地素材并完成', () => {
    expect(
      decideRecovery(facts({ dbState: 'verifying', targetState: 'valid' }))
    ).toEqual({ state: 'completed', registerLocalFile: true })
  })

  it('verifying 且目标文件校验失败：失败但不删目标文件', () => {
    expect(
      decideRecovery(facts({ dbState: 'verifying', targetState: 'invalid' }))
    ).toEqual({ state: 'failed', errorCode: 'E_VERIFY_FAILED' })
  })

  it('verifying 且只有 .part：回 paused 重新校验', () => {
    expect(decideRecovery(facts({ dbState: 'verifying', partBytes: 789 }))).toEqual({
      state: 'paused',
      receivedBytes: 789
    })
  })

  it('verifying 且两者都不存在：失败', () => {
    expect(decideRecovery(facts({ dbState: 'verifying' }))).toEqual({
      state: 'failed',
      errorCode: 'E_TEMP_MISSING'
    })
  })

  it('quarantined 且隔离区文件存在：保持隔离', () => {
    expect(
      decideRecovery(facts({ dbState: 'quarantined', quarantineExists: true }))
    ).toEqual({ state: 'quarantined' })
  })

  it('quarantined 且隔离区文件消失、目标文件就位：判定完成', () => {
    expect(
      decideRecovery(
        facts({ dbState: 'quarantined', quarantineExists: false, targetState: 'valid' })
      )
    ).toEqual({ state: 'completed', registerLocalFile: true })
  })

  it('quarantined 且目标文件校验失败：维持隔离，不擅自判定完成', () => {
    expect(
      decideRecovery(
        facts({ dbState: 'quarantined', quarantineExists: false, targetState: 'invalid' })
      )
    ).toEqual({ state: 'quarantined' })
  })

  it('completed 且目标文件丢失：标记 missing，不删记录', () => {
    expect(
      decideRecovery(facts({ dbState: 'completed', targetState: 'absent' }))
    ).toEqual({ state: 'completed', markLocalMissing: true })
  })

  it('completed 且目标文件仍在：保持完成', () => {
    expect(
      decideRecovery(facts({ dbState: 'completed', targetState: 'valid' }))
    ).toEqual({ state: 'completed' })
  })

  it('failed / canceled：保持原状态', () => {
    expect(decideRecovery(facts({ dbState: 'failed' }))).toEqual({ state: 'failed' })
    expect(decideRecovery(facts({ dbState: 'canceled' }))).toEqual({ state: 'canceled' })
  })
})
