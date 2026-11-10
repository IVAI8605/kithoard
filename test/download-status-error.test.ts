import { describe, expect, it } from 'vitest'
import { downloadStatusError } from '../src/main/download/engine'

describe('下载失败原因区分', () => {
  it('续期成功但下载仍 400：判定为直链过期', () => {
    const error = downloadStatusError(400, { attempted: true, errorCode: null })
    expect(error.code).toBe('E_LINK_EXPIRED')
    expect(error.message).toBe('素材直链已过期，自动续期未成功')
  })

  it('续期因断网失败：错误码说清是网络问题，而不是链接过期', () => {
    expect(downloadStatusError(400, { attempted: true, errorCode: 'E_NETWORK' }).code).toBe(
      'E_NETWORK'
    )
  })

  it('续期因 Key 失效失败：错误码说清是授权问题', () => {
    expect(downloadStatusError(400, { attempted: true, errorCode: 'E_AUTH_REQUIRED' }).code).toBe(
      'E_AUTH_REQUIRED'
    )
  })

  it('续期被限流时同样带上真实原因', () => {
    expect(downloadStatusError(400, { attempted: true, errorCode: 'E_RATE_LIMITED' }).code).toBe(
      'E_RATE_LIMITED'
    )
  })

  it('没试过续期时保持原有映射，不误判成链接过期', () => {
    // 400 在既有 engine 映射里落回 E_NETWORK；续期机制正是为这种「看着像网络问题」的失败补上准确原因
    expect(downloadStatusError(400, { attempted: false, errorCode: null }).code).toBe('E_NETWORK')
  })

  it('非 400 状态不受续期影响', () => {
    expect(downloadStatusError(404, { attempted: true, errorCode: 'E_NETWORK' }).code).toBe(
      'E_NETWORK'
    )
    expect(downloadStatusError(429, { attempted: true, errorCode: null }).code).toBe(
      'E_RATE_LIMITED'
    )
    expect(downloadStatusError(503, { attempted: true, errorCode: null }).code).toBe(
      'E_SOURCE_DOWN'
    )
  })
})
