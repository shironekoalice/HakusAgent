#!/usr/bin/env node
/**
 * mobile-audit.mjs — 逐元素 UI 审计工具
 *
 * 连接本机 Chrome（手机模式仿真）或 MuMu 的 CDP，执行：
 *   1. element <selector> [name]   — 按 getBoundingClientRect 裁剪截图单个元素
 *   2. region <x> <y> <w> <h> <name> — 按绝对坐标裁剪截图
 *   3. eval <expr>                 — 执行 JS 并打印结果
 *   4. rect <selector>             — 打印元素几何信息
 *   5. shot [name]                 — 视口整图
 *
 * 用法:
 *   node scripts/mobile-audit.mjs --port 9222 element ".composer-box" composer
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const portFlag = args.indexOf('--port')
const PORT = portFlag >= 0 ? args[portFlag + 1] : '9222'
const rest = args.filter((a, i) => i !== portFlag && i !== portFlag + 1)
const [cmd, ...rest2] = rest

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find(t => t.type === 'page' && !/devtools/.test(t.url))
if (!page) { console.error('no page target'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id
  pending.set(mid, { resolve, reject })
  ws.send(JSON.stringify({ id: mid, method, params }))
})
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
}
await new Promise(r => { ws.onopen = r })

const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error')
  return r.result.value
}

// Re-assert phone emulation on every connect (Chrome drops it on reload/navigation).
await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true })
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

mkdirSync('scripts/audit', { recursive: true })
const shot = async (clip, name) => {
  const p = { format: 'png', captureBeyondViewport: false }
  if (clip) p.clip = clip
  const r = await send('Page.captureScreenshot', p)
  const path = `scripts/audit/${name}.png`
  writeFileSync(path, Buffer.from(r.data, 'base64'))
  console.log(`saved ${path}`)
}

const rectOf = async (selector) => evalJS(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
})()`)

try {
  if (cmd === 'element') {
    const [selector, name = 'element'] = rest2
    const rect = await rectOf(selector)
    if (!rect) { console.error(`not found: ${selector}`); process.exit(1) }
    await shot({ ...rect, scale: 2 }, name)
    console.log(JSON.stringify(rect))
  } else if (cmd === 'region') {
    const [x, y, width, height, name = 'region'] = rest2
    await shot({ x: +x, y: +y, width: +width, height: +height, scale: 2 }, name)
  } else if (cmd === 'eval') {
    console.log(JSON.stringify(await evalJS(rest2.join(' '))))
  } else if (cmd === 'rect') {
    console.log(JSON.stringify(await rectOf(rest2[0])))
  } else {
    await shot(undefined, rest2[0] || 'viewport')
  }
} finally {
  ws.close()
}
