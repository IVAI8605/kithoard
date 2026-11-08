import type { AssetMeta, AssetType, SearchQuery } from '@shared/types'

export interface SourceCapabilities {
  types: AssetType[]
  requiresApiKey: boolean
  attributionRequired: boolean
  maxPageSize: number
  /** 搜索页是否必须显示来源文字（Pixabay 条款要求） */
  requiresSourceNotice: boolean
}

export interface SearchPage {
  items: AssetMeta[]
  page: number
  pageSize: number
  totalHits: number
  hasNext: boolean
  rateLimitRemaining: number | null
}

export interface DownloadPlan {
  url: string
  fileName: string
  headers: Record<string, string>
}

/** 适配器契约：不写库、不发下载、必须接 AbortSignal、异常上抛不返回空数组 */
export interface AssetSource {
  readonly id: string
  readonly name: string
  readonly capabilities: SourceCapabilities
  isReady(): boolean
  search(query: SearchQuery, signal: AbortSignal): Promise<SearchPage>
  getDetail(remoteId: string, signal: AbortSignal): Promise<AssetMeta>
  resolveDownload(remoteId: string, signal: AbortSignal): Promise<DownloadPlan>
  attributionOf(meta: AssetMeta): { text: string; url: string } | null
}
