export type BrowserTab = {
  id: string
  title: string
  url: string
  loading: boolean
}

let tabSequence = 0

export function createBrowserTab(url = ''): BrowserTab {
  tabSequence += 1
  return {
    id: `tab-${Date.now().toString(36)}-${tabSequence.toString(36)}`,
    title: '',
    url,
    loading: false,
  }
}

export function normalizeBrowserAddress(value: string): string {
  const input = value.trim()
  if (!input) return ''
  if (/^https?:\/\//i.test(input)) return input

  const hostLike = /^(localhost|127(?:\.\d{1,3}){3}|\[?[a-f\d:]+\]?|[\w-]+(?:\.[\w-]+)+)(?::\d{1,5})?(?:[/?#].*)?$/i
  if (hostLike.test(input)) return `https://${input}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(input)}`
}

export function getBrowserTabTitle(tab: BrowserTab, newTabLabel: string): string {
  if (tab.title.trim()) return tab.title.trim()
  if (!tab.url) return newTabLabel
  try {
    return new URL(tab.url).hostname || tab.url
  } catch {
    return tab.url
  }
}
