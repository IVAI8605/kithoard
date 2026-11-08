/**
 * 滑动窗口限流（默认 80 次/分钟，低于 Pixabay 官方 100）。
 * 用时间戳数组而不是令牌计数器，便于单测注入时钟、也方便解释「剩余额度」。
 */
export class TokenBucket {
  private stamps: number[] = []

  constructor(
    readonly capacity: number,
    readonly windowMs: number = 60_000,
    private readonly clock: () => number = Date.now
  ) {}

  private prune(now: number): void {
    this.stamps = this.stamps.filter((stamp) => now - stamp < this.windowMs)
  }

  take(): boolean {
    const now = this.clock()
    this.prune(now)
    if (this.stamps.length >= this.capacity) return false
    this.stamps.push(now)
    return true
  }

  get remaining(): number {
    this.prune(this.clock())
    return Math.max(0, this.capacity - this.stamps.length)
  }
}
