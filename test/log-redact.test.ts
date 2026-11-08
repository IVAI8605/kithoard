import { describe, expect, it } from 'vitest'
import { redactLine, redactText, redactUrl } from '../src/shared/log-redact'

describe('log redaction', () => {
  it('drops the whole query string, including api keys', () => {
    expect(redactUrl('https://pixabay.com/api/?key=SECRET&q=mountain')).toBe(
      'https://pixabay.com/api/?<redacted>'
    )
  })

  it('keeps scheme, host and path', () => {
    expect(redactUrl('https://pixabay.com/api/videos/')).toBe('https://pixabay.com/api/videos/')
  })

  it('does not throw on malformed urls', () => {
    expect(redactUrl('not a url')).toBe('<invalid-url>')
  })

  it('replaces the windows user name', () => {
    expect(redactText('C:\\Users\\ivai\\AppData\\Roaming\\kithoard\\logs')).toBe(
      'C:\\Users\\%USER%\\AppData\\Roaming\\kithoard\\logs'
    )
  })

  it('redacts urls embedded in a log line', () => {
    expect(redactLine('GET https://example.com/a?token=abc failed')).toBe(
      'GET https://example.com/a?<redacted> failed'
    )
  })
})
