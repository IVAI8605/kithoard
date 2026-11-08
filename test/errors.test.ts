import { describe, expect, it } from 'vitest'
import { ERROR_MESSAGES, isAppError, makeError } from '../src/shared/errors'

describe('error mapping', () => {
  it('uses chinese user facing messages', () => {
    expect(makeError('E_AUTH_REQUIRED').message).toBe('尚未配置该来源的 API Key')
  })

  it('marks only transient failures as retryable', () => {
    expect(makeError('E_NETWORK').retryable).toBe(true)
    expect(makeError('E_RATE_LIMITED').retryable).toBe(true)
    expect(makeError('E_AUTH_REQUIRED').retryable).toBe(false)
    expect(makeError('E_LICENSE_PAID').retryable).toBe(false)
  })

  it('keeps english detail out of the message', () => {
    const error = makeError('E_NETWORK', 'fetch failed: ECONNRESET')
    expect(error.message).toBe(ERROR_MESSAGES.E_NETWORK)
    expect(error.detail).toBe('fetch failed: ECONNRESET')
  })

  it('recognises app errors', () => {
    expect(isAppError(makeError('E_UNKNOWN'))).toBe(true)
    expect(isAppError(new Error('boom'))).toBe(false)
    expect(isAppError(null)).toBe(false)
  })
})
