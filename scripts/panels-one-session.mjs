/**
 * One session across the workbench panels — Phase 6 exit-gate driver.
 *
 * Proves that exercising the data surfaces of every panel (Chat hydration,
 * Session Log ledger replay, Tasks/plan events, Files/Editor listing, and a
 * live Terminal WebSocket) against ONE Runtime session creates NO second
 * turn and NO second session. The model is the deterministic todo stub
 * (`scripts/todo_stub.py`), so the single turn writes a todo plan and
 * finishes; the panels are then driven exactly the way the desktop drives
 * them (same endpoints, same WS protocol).
 *
 * Usage:
 *   node scripts/panels-one-session.mjs
 *   node scripts/panels-one-session.mjs --keep   # keep .dsh-panels artifacts
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 48081
const STUB_PORT = 48997
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = path.join(REPO, '.dsh-panels')
const HOME = path.join(ROOT, 'home')
const WORKSPACE = path.join(ROOT, 'workspace')
const BINARY = path.join(REPO, 'frontend', 'terminal', 'target', 'debug', 'hakus-tui.exe')
const STUB = path.join(REPO, 'scripts', 'todo_stub.py')
const CAPTURE = path.join(ROOT, 'stub-calls.jsonl')

let checks = 0
let failures = 0
let stubProc = null
let runtimeProc = null

function check(name, ok, detail = '') {
  checks++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' ' + detail}`)
  if (!ok) failures++
}

function httpJson(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const req = http.request(`${BASE}${urlPath}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: 60000,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try { resolve({ status: res.statusCode, json: JSON.parse(text) }) }
        catch { resolve({ status: res.statusCode, json: null, text }) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    if (data) req.write(data)
    req.end()
  })
}

const get = (p) => httpJson('GET', p)
const post = (p, b) => httpJson('POST', p, b)

async function waitReady(label, url, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 400))
  }
  console.error(`${label} not ready within ${timeoutSec}s`)
  return false
}

/** Minimal raw WebSocket client (no deps) — enough for /ws/terminal. */
class RawWebSocket {
  constructor(url, headers = {}) {
    const u = new URL(url)
    this.pendingOpen = new Promise((res, rej) => {
      this.sock = net.connect(Number(u.port), u.hostname)
      this.sock.on('error', rej)
      this.sock.on('connect', () => {
        const key = crypto.randomBytes(16).toString('base64')
        // The desktop client connects from an allowed origin (dev server or
        // Tauri); the driver presents the same one the real client gets.
        const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')
        this.sock.write(
          `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`)
      })
      let handshaken = false
      this.buf = Buffer.alloc(0)
      this.closed = false
      this.onmessage = null
      this.sock.on('data', (chunk) => {
        if (process.env.DEBUG_WS) console.log('    ws raw chunk:', chunk.length, 'handshaken=', handshaken)
        this.buf = Buffer.concat([this.buf, chunk])
        if (!handshaken) {
          const i = this.buf.indexOf('\r\n\r\n')
          if (i < 0) return
          const status = this.buf.subarray(0, i).toString('utf8')
          if (!status.includes(' 101 ')) { rej(new Error('handshake: ' + status.split('\r\n')[0])); return }
          this.buf = this.buf.subarray(i + 4)
          handshaken = true
          if (process.env.DEBUG_WS) console.log('    ws handshake done, leftover=', this.buf.length)
          res()
        }
        try {
          this.drain()
        } catch (e) {
          console.error('    ws drain threw:', e)
        }
      })
    })
  }
  drain() {
    for (;;) {
      if (this.buf.length < 2) return
      if (process.env.DEBUG_WS) console.log('    ws drain buf:', this.buf.length, JSON.stringify(this.buf.subarray(0, 8).toString('hex')), JSON.stringify(this.buf.subarray(0, 40).toString('utf8')))
      const b0 = this.buf[0], b1 = this.buf[1]
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let off = 2
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10 }
      if (masked) off += 4
      if (this.buf.length < off + len) return
      let payload = this.buf.subarray(off, off + len)
      if (masked) {
        const mask = this.buf.subarray(off - 4, off)
        const un = Buffer.allocUnsafe(len)
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3]
        payload = un
      }
      this.buf = this.buf.subarray(off + len)
      if (process.env.DEBUG_WS) console.log('    ws frame op=', opcode, 'len=', len)
      if (opcode === 8) { this.closed = true; this.sock.end(); return }
      if (opcode === 1 || opcode === 2 || opcode === 0) {
        this.onmessage?.(payload)
      }
    }
  }
  sendText(str) {
    const data = Buffer.from(str, 'utf8')
    const mask = crypto.randomBytes(4)
    let head
    if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length])
    else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(data.length, 2) }
    const masked = Buffer.allocUnsafe(data.length)
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3]
    this.sock.write(Buffer.concat([head, mask, masked]))
  }
  close() { try { this.sock.end() } catch { /* ignore */ } }
}

async function driveTerminal() {
  const ws = new RawWebSocket(`ws://127.0.0.1:${PORT}/ws/terminal`, {
    Origin: 'http://localhost:1420',
  })
  await ws.pendingOpen
  const output = []
  ws.onmessage = (payload) => {
    const text = payload.toString('utf8')
    output.push(text)
    // ConPTY emits a cursor-position query and xterm.js answers it
    // automatically; a raw client must answer too or output stalls.
    if (text.includes('\x1b[6n')) {
      ws.sendText(JSON.stringify({ type: 'stdin', data: '\x1b[1;1R' }))
    }
  }
  // Exactly the frames TerminalPanel.tsx sends.
  ws.sendText(JSON.stringify({ type: 'init', cwd: WORKSPACE, cols: 80, rows: 24 }))
  await new Promise((r) => setTimeout(r, 1200))
  ws.sendText(JSON.stringify({ type: 'stdin', data: 'echo PANEL_TERMINAL_OK\r\n' }))
  // Ground truth for the shell's real cwd: write a marker file and find it
  // through the workspace git-status surface. Prompt string matching is
  // fragile (ConPTY redraws and locale), a file in the workspace is not.
  await new Promise((r) => setTimeout(r, 1200))
  ws.sendText(JSON.stringify({ type: 'stdin', data: 'echo terminal-cwd-proof > PANEL_MARKER.txt\r\n' }))
  const deadline = Date.now() + 15000
  let joined = ''
  while (Date.now() < deadline) {
    joined = output.join('')
    if (joined.includes('PANEL_TERMINAL_OK') && fs.existsSync(path.join(WORKSPACE, 'PANEL_MARKER.txt'))) break
    await new Promise((r) => setTimeout(r, 200))
  }
  ws.close()
  if (!joined.includes('PANEL_TERMINAL_OK')) {
    console.log(`    terminal output captured (${output.length} frames):`, JSON.stringify(joined.slice(0, 1200)))
  }
  return joined
}

async function turnStatus(threadId, turnId, timeoutSec) {
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted']
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    const { json } = await get(`/v1/threads/${threadId}`)
    const t = (json?.turns || []).find((x) => x.id === turnId)
    if (t && terminal.includes(t.status)) return t.status
    await new Promise((r) => setTimeout(r, 500))
  }
  return 'timeout'
}

function stop(proc) { try { proc?.kill() } catch { /* ignore */ } }

// ---------------------------------------------------------------- setup
fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(HOME, { recursive: true })
fs.mkdirSync(WORKSPACE, { recursive: true })
fs.writeFileSync(path.join(WORKSPACE, 'README.md'), 'one session across panels\n')
// A git workspace is what the Files/Review surfaces project (git status + diff).
function git(args) {
  execFileSync('git', args, { cwd: WORKSPACE, stdio: 'ignore' })
}
git(['init', '--quiet'])
git(['config', 'user.email', 'panels@smoke.local'])
git(['config', 'user.name', 'Panel Smoke'])
git(['add', '-A'])
git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'seed'])
fs.writeFileSync(path.join(HOME, 'config.toml'), `provider = "local"
default_text_model = "todo-stub-model"

allow_shell = false
approval_policy = "never"
sandbox_mode = "workspace-write"

[providers.local]
kind = "openai-compatible"
display_name = "Panel smoke stub"
api_key = "stub-key"
base_url = "http://127.0.0.1:${STUB_PORT}/v1"
model = "todo-stub-model"
wire = "openai"
models = ["todo-stub-model"]

[update]
check_for_updates = false
`, 'utf8')

try {
  console.log('== 1. Start the model stub and the Runtime ==')
  stubProc = spawn('python', [STUB, '--port', String(STUB_PORT), '--out', CAPTURE], { stdio: 'ignore' })
  check('model stub listening', await waitReady('stub', `http://127.0.0.1:${STUB_PORT}/v1/models`, 30))

  runtimeProc = spawn(BINARY, ['serve', '--http', '--insecure', '--port', String(PORT)], {
    cwd: WORKSPACE,
    env: { ...process.env, HAKUS_HOME: HOME, DEEPSEEK_HOME: HOME },
    stdio: ['ignore', fs.openSync(path.join(ROOT, 'runtime.log'), 'w'), fs.openSync(path.join(ROOT, 'runtime.err'), 'w')],
  })
  check('runtime reports ready', await waitReady('runtime', `${BASE}/health`, 120))
  const { json: health } = await get('/health')
  check('runtime execution plane is rust', health?.execution_plane === 'rust', `got '${health?.execution_plane}'`)

  console.log('== 2. One session, one turn (todo plan) ==')
  const { json: thread } = await post('/v1/threads', { title: 'Panels one session', mode: 'agent', archived: false })
  const tid = thread?.id
  check('thread created', Boolean(tid), `id='${tid}'`)
  const { json: turnResp } = await post(`/v1/threads/${tid}/turns`, { prompt: 'write the plan' })
  const turnId = turnResp?.turn?.id
  check('turn accepted', Boolean(turnId))
  const status = await turnStatus(tid, turnId, 180)
  check('turn completed', status === 'completed', `status=${status}`)

  console.log('== 3. Exercise every panel surface for this session ==')
  // Chat hydration — thread detail keyed by the same id.
  const { json: detail } = await get(`/v1/threads/${tid}`)
  check('Chat: thread detail serves the same session', detail?.thread?.id === tid)
  // Session Log + Tasks: canonical ledger replay carries the plan events.
  const { json: ledger } = await get(`/v1/threads/${tid}/ledger?limit=500`)
  const events = ledger?.events || []
  check('Session Log: ledger replays events', events.length > 0, `count=${events.length}`)
  const progress = events.find((e) => (e.event_type || e.event || '').includes('task.progress')
    || (e.payload?.items && e.payload?.total))
  check('Tasks: plan (task.progress) events present in the same ledger', Boolean(progress),
    `types=${events.map((e) => e.event_type || e.event).join(',')}`)
  // Files/Editor + Review: git-status and diff surfaces are keyed to the
  // session workspace (FilesPanel.getGitStatus / DiffReview diff source).
  const wsStatus = await get('/v1/workspace/status/files')
  check('Files/Editor: git status serves the session workspace',
    wsStatus.status === 200 && wsStatus.json?.is_repo === true
      && path.normalize(wsStatus.json?.workdir || '') === path.normalize(WORKSPACE),
    `status=${wsStatus.status} body=${JSON.stringify(wsStatus.json).slice(0, 200)}`)
  const wsDiff = await get('/v1/workspace/diff')
  check('Review: diff surface serves the session workspace',
    wsDiff.status === 200 && path.normalize(wsDiff.json?.workdir || '') === path.normalize(WORKSPACE),
    `status=${wsDiff.status} body=${JSON.stringify(wsDiff.json).slice(0, 160)}`)
  // Terminal: the real /ws/terminal protocol in the session workspace.
  const termOut = await driveTerminal()
  check('Terminal: /ws/terminal executes in the session workspace', termOut.includes('PANEL_TERMINAL_OK'))
  // The ready frame reports the shell cwd; a UNC fallback would show the
  // "UNC 路径不受支持" banner and a C:\Windows prompt. (cmd.exe's own title
  // escape legitimately mentions its executable path — that is not the cwd.)
  const readyMatch = termOut.match(/\{"type":"ready","cwd":"((?:[^"\\]|\\.)*)"\}/)
  const readyCwd = readyMatch ? JSON.parse(`"${readyMatch[1]}"`) : ''
  // Ground truth: the marker file the terminal shell wrote lands in the
  // session workspace (the UNC-fallback failure mode wrote it to
  // C:\Windows instead). The UNC-fallback failure mode shows "UNC 路径不受
  // 支持" and a C:\Windows prompt.
  const wsStatusAfterTerm = await get('/v1/workspace/status/files')
  const untracked = JSON.stringify(wsStatusAfterTerm.json?.untracked || [])
  const readyVerbatim = readyCwd.includes('\\\\?\\') || readyCwd.toLowerCase().startsWith('\\\\?\\')
  check('Terminal: session cwd is the plain workspace path (no verbatim prefix, no UNC fallback)',
    readyCwd && !readyVerbatim
      && untracked.includes('PANEL_MARKER.txt')
      && !termOut.includes('UNC'),
    `readyCwd=${JSON.stringify(readyCwd)} untracked=${untracked.slice(0, 200)} uncAt=${termOut.indexOf('UNC')}`)
  if (termOut.includes('UNC') && process.env.DEBUG_WS) {
    console.log('    UNC context:', JSON.stringify(termOut.slice(Math.max(0, termOut.indexOf('UNC') - 80), termOut.indexOf('UNC') + 120)))
  }

  console.log('== 4. Invariants: no second turn, no second session ==')
  const { json: after } = await get(`/v1/threads/${tid}`)
  check('still exactly one turn on the session', (after?.turns || []).length === 1, `turns=${(after?.turns || []).length}`)
  const { json: verify } = await get(`/v1/threads/${tid}/ledger/verify`)
  check('ledger verifies contiguous', verify?.contiguous === true, JSON.stringify(verify))
  const { json: diag } = await get('/v1/diagnostics')
  check('runtime holds exactly one canonical session', (diag?.canonical_ledger_session_count ?? -1) === 1,
    `sessions=${diag?.canonical_ledger_session_count}`)
} catch (e) {
  console.error('DRIVER ERROR:', e.message)
  failures++
} finally {
  stop(stubProc)
  stop(runtimeProc)
  // Free the port before exiting so a rerun starts clean.
  await new Promise((r) => setTimeout(r, 1000))
}

console.log('')
console.log(failures === 0 ? `PANELS ONE SESSION PASS - ${checks}/${checks} checks` : `PANELS ONE SESSION FAIL - ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
