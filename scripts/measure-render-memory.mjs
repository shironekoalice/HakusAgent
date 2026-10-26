/**
 * Inspect the packaged desktop page through WebView2 CDP.
 *
 * The script intentionally changes only the current page when --disable-
 * backdrop-filter is supplied. It is a measurement aid, not a product flag.
 */
import { connect } from './cdp.mjs'

const port = Number(process.env.CDP_PORT || 9223)
const disableBackdrop = process.argv.includes('--disable-backdrop-filter')

const { cdp, page } = await connect(port)
try {
  const before = await cdp.evalIn(`(() => {
    const elements = [...document.querySelectorAll('*')]
    const activeBackdrop = elements.filter((element) => {
      const style = getComputedStyle(element)
      const value = String(style.backdropFilter || style.webkitBackdropFilter || '').trim()
      return value && value !== 'none'
    }).length
    return {
      title: document.title,
      readyState: document.readyState,
      elementCount: elements.length,
      activeBackdrop,
      markdownChunkLoaded: performance
        .getEntriesByType('resource')
        .some((entry) => entry.name.includes('MarkdownMessage')),
      optionalChunksLoaded: performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => /MarkdownMessage|SettingsDialog|RemoteProjectWizard|FirstRunSetup/.test(name)),
    }
  })()`)
  if (disableBackdrop) {
    await cdp.evalIn(`(() => {
      const style = document.createElement('style')
      style.dataset.hakusMemoryProbe = 'disable-backdrop-filter'
      style.textContent = '* { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }'
      document.head.appendChild(style)
      for (const element of document.querySelectorAll('*')) {
        element.style.setProperty('-webkit-backdrop-filter', 'none', 'important')
        element.style.setProperty('backdrop-filter', 'none', 'important')
      }
      return true
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  const after = await cdp.evalIn(`(() => {
    const elements = [...document.querySelectorAll('*')]
    const activeBackdrop = elements.filter((element) => {
      const style = getComputedStyle(element)
      const value = String(style.backdropFilter || style.webkitBackdropFilter || '').trim()
      return value && value !== 'none'
    }).length
    return {
      elementCount: elements.length,
      activeBackdrop,
      markdownChunkLoaded: performance
        .getEntriesByType('resource')
        .some((entry) => entry.name.includes('MarkdownMessage')),
      optionalChunksLoaded: performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => /MarkdownMessage|SettingsDialog|RemoteProjectWizard|FirstRunSetup/.test(name)),
    }
  })()`)
  console.log(JSON.stringify({ port, page: page.url, disableBackdrop, before, after }))
} finally {
  cdp.close()
}
