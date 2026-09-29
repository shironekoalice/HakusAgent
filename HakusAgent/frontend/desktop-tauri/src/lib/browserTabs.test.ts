import { describe, expect, it } from 'vitest'
import { createBrowserTab, getBrowserTabTitle, normalizeBrowserAddress } from './browserTabs'

describe('browser tab helpers', () => {
  it('creates distinct in-memory tab identifiers', () => {
    expect(createBrowserTab().id).not.toBe(createBrowserTab().id)
  })

  it('keeps explicit web URLs and adds HTTPS to host-like input', () => {
    expect(normalizeBrowserAddress('http://localhost:1420/path')).toBe('http://localhost:1420/path')
    expect(normalizeBrowserAddress('example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeBrowserAddress('localhost:1420')).toBe('https://localhost:1420')
  })

  it('turns non-host text into an encoded search URL', () => {
    expect(normalizeBrowserAddress('  hello world  ')).toBe('https://duckduckgo.com/?q=hello%20world')
    expect(normalizeBrowserAddress('')).toBe('')
  })

  it('uses the page title, host, then new-tab label in that order', () => {
    expect(getBrowserTabTitle({ id: 'tab-1', title: 'Docs', url: 'https://example.com/a', loading: false }, 'New Tab')).toBe('Docs')
    expect(getBrowserTabTitle({ id: 'tab-2', title: '', url: 'https://example.com/a', loading: false }, 'New Tab')).toBe('example.com')
    expect(getBrowserTabTitle({ id: 'tab-3', title: '', url: '', loading: false }, 'New Tab')).toBe('New Tab')
  })
})
