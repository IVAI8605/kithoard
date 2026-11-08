import { describe, expect, it } from 'vitest'
import type { AppError } from '../src/shared/errors'
import { isAppError } from '../src/shared/errors'
import { validateSearchQuery } from '../src/main/services/validate'

function capture(run: () => void): AppError {
  try {
    run()
  } catch (error) {
    if (isAppError(error)) return error
  }
  throw new Error('expected an AppError')
}

describe('search query guard', () => {
  it('trims the keyword and keeps valid paging', () => {
    expect(
      validateSearchQuery({ keyword: '  mountain  ', type: 'image', page: 2, pageSize: 20 })
    ).toEqual({ keyword: 'mountain', type: 'image', page: 2, pageSize: 20 })
  })

  it('rejects other types for now', () => {
    const error = capture(() => validateSearchQuery({ keyword: 'a', type: 'audio', page: 1, pageSize: 20 }))
    expect(error.code).toBe('E_INVALID_ARG')
  })

  it('rejects empty keywords', () => {
    expect(capture(() => validateSearchQuery({ keyword: '   ', type: 'image', page: 1, pageSize: 20 })).code).toBe(
      'E_INVALID_ARG'
    )
  })

  it('caps page size at 20', () => {
    expect(capture(() => validateSearchQuery({ keyword: 'a', type: 'image', page: 1, pageSize: 21 })).code).toBe(
      'E_INVALID_ARG'
    )
  })

  it('rejects non integer pages', () => {
    expect(capture(() => validateSearchQuery({ keyword: 'a', type: 'image', page: 1.5, pageSize: 20 })).code).toBe(
      'E_INVALID_ARG'
    )
  })
})
