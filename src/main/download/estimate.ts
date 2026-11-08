import type { DownloadEstimate } from '@shared/types'

export interface EstimateInput {
  sizeBytes: number | null
}

/**
 * 批量下载前的体量预估（§7.4-8）。
 * 只要有一条大小未知就整体返回 null：不把已知部分求和冒充总数，
 * 也不按平均值估算——数据诚实优先于「看起来更完整」。
 */
export function summarizeEstimate(rows: EstimateInput[]): DownloadEstimate {
  if (rows.length === 0) return { count: 0, bytes: null }

  let total = 0
  for (const row of rows) {
    // 0 字节对素材没有意义，按未知处理；负数是脏数据，同样不参与求和
    if (row.sizeBytes === null || !Number.isFinite(row.sizeBytes) || row.sizeBytes <= 0) {
      return { count: rows.length, bytes: null }
    }
    total += row.sizeBytes
  }
  return { count: rows.length, bytes: total }
}
