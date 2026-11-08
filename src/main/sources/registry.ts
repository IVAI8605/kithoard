import { TokenBucket } from './rate-limit'
import type { AssetSource } from './types'

export interface RegisteredSource {
  adapter: AssetSource
  bucket: TokenBucket
}

export class SourceRegistry {
  private readonly entries = new Map<string, RegisteredSource>()

  register(adapter: AssetSource, perMinute: number): void {
    this.entries.set(adapter.id, { adapter, bucket: new TokenBucket(perMinute) })
  }

  get(id: string): RegisteredSource | undefined {
    return this.entries.get(id)
  }

  all(): RegisteredSource[] {
    return [...this.entries.values()]
  }
}
