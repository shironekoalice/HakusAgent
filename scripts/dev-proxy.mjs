#!/usr/bin/env node
/**
 * dev-proxy.mjs — 本地开发反向代理：把浏览器仿真页面的 /v1 请求转发到
 * MuMu 内的 Runtime（经 adb forward 的 127.0.0.1:48099），并补 CORS 头，
 * 使 http://127.0.0.1:14299 (vite) 能直接访问。
 */
import http from 'node:http'

const UPSTREAM = 'http://127.0.0.1:48099'
const PORT = 48090

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  try {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const url = UPSTREAM + req.url
    const headers = { ...req.headers }
    delete headers.host; delete headers.origin; delete headers.referer
    const up = await fetch(url, { method: req.method, headers, body: body.length ? body : undefined, duplex: 'half' })
    res.writeHead(up.status, Object.fromEntries([...up.headers.entries()].filter(([k]) => !k.startsWith('access-control'))))
    const buf = Buffer.from(await up.arrayBuffer())
    res.end(buf)
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(e) }))
  }
}).listen(PORT, '127.0.0.1', () => console.log(`dev-proxy: http://127.0.0.1:${PORT} -> ${UPSTREAM}`))
