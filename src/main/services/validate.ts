import { makeError } from '@shared/errors'
import type { SearchQuery } from '@shared/types'

const KEYWORD_MAX = 100
const PAGE_MAX = 500
const PAGE_SIZE_MAX = 20

export function validateSearchQuery(input: unknown): SearchQuery {
  if (typeof input !== 'object' || input === null) throw makeError('E_INVALID_ARG')

  const record = input as Record<string, unknown>
  const keyword = typeof record.keyword === 'string' ? record.keyword.trim() : ''
  if (!keyword || keyword.length > KEYWORD_MAX) throw makeError('E_INVALID_ARG', 'keyword')

  const type = record.type
  if (type !== 'image' && type !== 'video') throw makeError('E_INVALID_ARG', 'type')

  const page = Number(record.page)
  if (!Number.isInteger(page) || page < 1 || page > PAGE_MAX) {
    throw makeError('E_INVALID_ARG', 'page')
  }

  const pageSize = Number(record.pageSize)
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE_MAX) {
    throw makeError('E_INVALID_ARG', 'pageSize')
  }

  return { keyword, type, page, pageSize }
}
