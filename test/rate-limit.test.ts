import { describe, expect, it } from 'vitest'
import { TokenBucket } from '../src/main/sources/rate-limit'

describe('token bucket', () => {
  it('allows requests up to capacity then blocks', () => {
    let now = 1_000
    const bucket = new TokenBucket(3, 60_000, () => now)

    expect(bucket.take()).toBe(true)
    expect(bucket.take()).toBe(true)
    expect(bucket.take()).toBe(true)
    expect(bucket.take()).toBe(false)
    expect(bucket.remaining).toBe(0)
  })

  it('refills after the window slides', () => {
    let now = 0
    const bucket = new TokenBucket(2, 60_000, () => now)

    expect(bucket.take()).toBe(true)
    expect(bucket.take()).toBe(true)
    expect(bucket.take()).toBe(false)

    now = 60_001
    expect(bucket.remaining).toBe(2)
    expect(bucket.take()).toBe(true)
  })

  it('never reports negative remaining', () => {
    let now = 0
    const bucket = new TokenBucket(1, 1_000, () => now)
    bucket.take()
    bucket.take()
    expect(bucket.remaining).toBe(0)
    now = 2_000
    expect(bucket.remaining).toBe(1)
  })
})
