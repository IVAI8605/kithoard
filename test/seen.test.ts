import { describe, expect, it } from 'vitest'
import { createSeenTracker } from '../src/main/services/seen'

describe('翻页去重', () => {
  it('把上一页出现过的命中挡掉', () => {
    const tracker = createSeenTracker()
    const key = 'pixabay:image:mountain'
    expect(Array.from(tracker.accept(key, 1, ['a', 'b']))).toEqual(['a', 'b'])
    expect(Array.from(tracker.accept(key, 2, ['b', 'c']))).toEqual(['c'])
  })

  it('同一页内重复只保留一条', () => {
    const tracker = createSeenTracker()
    expect(Array.from(tracker.accept('pixabay:image:mountain', 1, ['a', 'a', 'b']))).toEqual(['a', 'b'])
  })

  it('回到第 1 页时清空记录，列表不会被误判成全重复', () => {
    const tracker = createSeenTracker()
    const key = 'pixabay:image:mountain'
    tracker.accept(key, 1, ['a', 'b'])
    tracker.accept(key, 2, ['c'])
    expect(Array.from(tracker.accept(key, 1, ['a', 'b']))).toEqual(['a', 'b'])
  })

  it('不同关键词之间互不影响', () => {
    const tracker = createSeenTracker()
    tracker.accept('pixabay:image:mountain', 1, ['a'])
    expect(Array.from(tracker.accept('pixabay:image:river', 2, ['a']))).toEqual(['a'])
  })

  it('超出查询数上限时淘汰最早的记录', () => {
    const tracker = createSeenTracker({ maxQueries: 1 })
    tracker.accept('q1', 1, ['a'])
    tracker.accept('q2', 1, ['a'])
    // q1 已被淘汰，因此 q2 之后再查 q1 不会把 a 当重复
    expect(Array.from(tracker.accept('q1', 2, ['a']))).toEqual(['a'])
  })
})
