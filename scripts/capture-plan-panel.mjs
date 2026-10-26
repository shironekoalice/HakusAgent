/**
 * Render the plan panel in the real desktop WebView2 and capture it.
 *
 * The point is to see the actual rendered pixels rather than assert over props:
 * this change was about placement and density, and the previous layout was
 * wrong in a way no unit test would have caught (two expanded copies of the
 * same plan, one of them oversized).
 *
 * Imports the true component through vite so the real Tailwind styles and the
 * real `cn` helper apply. Requires the dev server, plus a WebView launched with
 * remote debugging on CDP_PORT (default 9223).
 */
import { writeFileSync } from 'node:fs'
import { connect } from './cdp.mjs'

const PORT = Number(process.env.CDP_PORT || 9223)
const OUT = process.env.OUT || 'doc/task-plan-panel.png'

const { cdp, page } = await connect(PORT)
console.log('attached:', page.title, '|', page.url)

// Mount a harness into the live document. Vite serves /src/*.tsx, so the real
// component module (and its real imports) load here. Bare specifiers like
// `react` do not resolve in a raw browser context, so they go through Vite's
// dep-optimizer paths.
const MOUNT = `
(async () => {
  const React = (await import('/node_modules/.vite/deps/react.js')).default
  // Vite's CJS interop exposes the namespace on .default for some deps and
  // spreads it on others; accept either rather than pinning one shape.
  const rdom = await import('/node_modules/.vite/deps/react-dom_client.js')
  const createRoot = rdom.createRoot || rdom.default?.createRoot
  if (!createRoot) throw new Error('createRoot not found: ' + Object.keys(rdom).join(','))
  const mod = await import('/src/components/chat/TaskPlanPanel.tsx')

  const runtimeProgress = {
    completed: 1, total: 3, current_task: 'map the frame',
    tasks: ['inspect the ledger', 'map the frame', 'check the app'],
    items: [
      { content: 'inspect the ledger', status: 'completed' },
      { content: 'map the frame', status: 'in_progress' },
      { content: 'check the app', status: 'pending' },
    ],
  }
  const cancelledProgress = {
    completed: 1, total: 3, current_task: 'map the frame',
    items: [
      { content: 'abandoned probe', status: 'cancelled' },
      { content: 'map the frame', status: 'in_progress' },
      { content: 'check the app', status: 'pending' },
    ],
  }
  const finishedProgress = {
    completed: 3, total: 3, current_task: '',
    items: [
      { content: 'inspect the ledger', status: 'completed' },
      { content: 'map the frame', status: 'completed' },
      { content: 'check the app', status: 'completed' },
    ],
  }
  const legacyProgress = {
    completed: 2, total: 3, current_task: 'third thing',
    tasks: ['first', 'second', 'third thing'],
  }

  const Label = (text) => React.createElement('div', {
    style: { fontSize: 11, color: 'rgb(148 163 184)', margin: '0 0 4px 2px', fontFamily: 'system-ui' },
  }, text)

  const Cell = (label, el) => React.createElement('div', {
    style: { display: 'flex', flexDirection: 'column', width: 520 },
  }, Label(label), el)

  const h = React.createElement
  const tree = h('div', {
    id: 'plan-harness',
    style: {
      position: 'fixed', inset: '0', zIndex: 2147483000,
      background: 'rgb(9 9 11)', padding: '20px',
      display: 'flex', flexDirection: 'column', gap: 18, overflow: 'auto',
      fontFamily: 'system-ui, sans-serif',
    },
  },
    Cell('Runtime frame (per-row status) — collapsed, the default', h(mod.TaskPlanPanel, { progress: runtimeProgress })),
    Cell('Same frame — expanded (needs a click; recorded via prop probe below)', h(mod.TaskPlanPanel, { progress: runtimeProgress })),
    Cell('Cancelled row must stay distinct from completed', h(mod.TaskPlanPanel, { progress: cancelledProgress })),
    Cell('All settled', h(mod.TaskPlanPanel, { progress: finishedProgress })),
    Cell('Legacy name-only frame (prefix-count fallback)', h(mod.TaskPlanPanel, { progress: legacyProgress })),
    Cell('Transcript receipt — the one-line form', h(mod.TaskPlanReceipt, { progress: runtimeProgress })),
    Cell('No plan — renders nothing (no empty box)', h(mod.TaskPlanPanel, { progress: undefined })),
  )

  const host = document.createElement('div')
  document.body.appendChild(host)
  window.__planHarness = createRoot(host)
  window.__planHarness.render(tree)

  // Wait for the panels to be in the DOM, then expand every one of them so the
  // capture shows the expanded state too — the collapsed default is the point,
  // but the expanded rows are what a user checks when they want the list.
  await new Promise((r) => setTimeout(r, 300))
  const buttons = [...document.querySelectorAll('#plan-harness section button[aria-expanded]')]
  return { expandedButtons: buttons.length, panels: document.querySelectorAll('[data-testid="task-plan-panel"]').length }
})()
`

const mounted = await cdp.evalIn(MOUNT)
console.log('mount:', JSON.stringify(mounted))

// Capture the collapsed state first — that is the default users see.
const shotCollapsed = await cdp.send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT.replace(/\.png$/, '-collapsed.png'), Buffer.from(shotCollapsed.data, 'base64'))
console.log('wrote', OUT.replace(/\.png$/, '-collapsed.png'))

// Then expand every panel and capture again.
const expand = await cdp.evalIn(`
(() => {
  const buttons = [...document.querySelectorAll('#plan-harness section button[aria-expanded]')]
  buttons.forEach((b) => { if (b.getAttribute('aria-expanded') === 'false') b.click() })
  return { clicked: buttons.length }
})()
`)
console.log('expand:', JSON.stringify(expand))
await new Promise((r) => setTimeout(r, 250))

const shotExpanded = await cdp.send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT.replace(/\.png$/, '-expanded.png'), Buffer.from(shotExpanded.data, 'base64'))
console.log('wrote', OUT.replace(/\.png$/, '-expanded.png'))

// Report the measured geometry, so the density claim is a number and not a vibe.
const metrics = await cdp.evalIn(`
(() => {
  const panels = [...document.querySelectorAll('#plan-harness [data-testid="task-plan-panel"]')]
  return panels.map((p) => {
    const r = p.getBoundingClientRect()
    return { h: Math.round(r.height), w: Math.round(r.width), expanded: p.querySelector('button')?.getAttribute('aria-expanded') }
  })
})()
`)
console.log('panel geometry (css px):', JSON.stringify(metrics))

// Clean up so the app is left as it was found.
await cdp.evalIn(`
(() => {
  window.__planHarness?.unmount()
  document.getElementById('plan-harness')?.remove()
  return true
})()
`)
console.log('harness removed')
process.exit(0)
