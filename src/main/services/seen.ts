/**
 * Pixabay 对同一关键词的相邻页会稳定返回同一条命中（实测 "mountain" 第 1、2 页重复 id 5854210）。
 * 不去重的话界面会出现两张一模一样的卡片，验收条目「翻页内容不重复」直接不过。
 *
 * 只在同一关键词内去重，且回到第 1 页时清空：既挡住重复，又避免用户往回翻时列表变成空的。
 * 状态只放内存并设上限，不做持久化——重启后重新从第 1 页开始，行为仍然正确。
 */
export interface SeenTracker {
  /** 返回本页应当保留的 remoteId；调用即视为"已见" */
  accept(queryKey: string, page: number, remoteIds: string[]): Set<string>
}

export function createSeenTracker(options?: {
  maxQueries?: number
  maxIdsPerQuery?: number
}): SeenTracker {
  const maxQueries = options?.maxQueries ?? 50
  const maxIdsPerQuery = options?.maxIdsPerQuery ?? 1000
  const store = new Map<string, Set<string>>()

  return {
    accept(queryKey, page, remoteIds) {
      // 回到第 1 页意味着重新开始浏览，旧记录会让整页被误判成重复
      if (page <= 1) store.delete(queryKey)

      let seen = store.get(queryKey)
      if (!seen) {
        seen = new Set<string>()
        store.set(queryKey, seen)
        // 简单 FIFO 淘汰，防止长期使用后无限增长
        if (store.size > maxQueries) {
          const oldest = store.keys().next().value
          if (oldest !== undefined) store.delete(oldest)
        }
      }

      const kept = new Set<string>()
      for (const id of remoteIds) {
        if (seen.has(id)) continue
        kept.add(id)
        if (seen.size < maxIdsPerQuery) seen.add(id)
      }
      return kept
    }
  }
}
