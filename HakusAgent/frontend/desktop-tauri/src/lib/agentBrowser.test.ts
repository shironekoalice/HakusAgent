import { describe, expect, it } from 'vitest'
import { parseBrowserAction } from './agentBrowser'

describe('parseBrowserAction', () => {
  it('accepts tab navigation actions', () => {
    expect(parseBrowserAction({ action: 'open_tab', url: 'https://example.com' })).toEqual({
      action: 'open_tab',
      url: 'https://example.com',
    })
    expect(parseBrowserAction({ action: 'switch_tab', tabId: 'tab-1' })).toEqual({
      action: 'switch_tab',
      tabId: 'tab-1',
    })
    expect(parseBrowserAction({ action: 'list_tabs' })).toEqual({ action: 'list_tabs' })
  })

  it('rejects unsupported or incomplete actions', () => {
    expect(() => parseBrowserAction({ action: 'execute_script' })).toThrow('Unsupported browser action')
    expect(() => parseBrowserAction({ action: 'switch_tab' })).toThrow('Switch tab requires a tab ID')
    expect(() => parseBrowserAction({ action: 'click' })).toThrow('Click requires a selector or text')
    expect(() => parseBrowserAction({ action: 'list_tabs', command: 'unexpected' })).toThrow('unsupported fields')
  })
})
