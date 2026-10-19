#!/usr/bin/env node
/**
 * mobile-eval.mjs — evaluate JS in the Android WebView over CDP (no deps).
 * Usage: adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *        node scripts/mobile-eval.mjs "document.title"
 */
const expr = process.argv[2] ?? 'document.title'
const targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json())
const page = targets.find(t => t.type === 'page')
if (!page) { console.error('no page target'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
function send(method, params) {
  return new Promise((resolve) => {
    const msgId = ++id
    pending.set(msgId, resolve)
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
ws.onopen = async () => {
  const res = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  })
  if (res.error) console.error('CDP error:', JSON.stringify(res.error))
  else {
    const r = res.result?.result
    if (r?.type === 'string') console.log(r.value)
    else console.log(JSON.stringify(r?.value, null, 2))
  }
  ws.close()
  process.exit(0)
}
ws.onerror = (e) => { console.error('ws error', e.message ?? e); process.exit(1) }
