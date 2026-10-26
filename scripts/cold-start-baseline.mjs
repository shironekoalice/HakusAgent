/**
 * Cold-start baseline driver (Phase 0 / spec 1.3).
 *
 * Launches the real Rust Runtime binary N times from an isolated, freshly
 * seeded home so every launch is clean, and measures per launch:
 *   spawn          — process created
 *   runtime_ready  — GET /health answers 200 (the runtime-owned share of
 *                    the spec's 5 s cold-start budget)
 *   first_event    — thread created → canonical ledger first event readable
 *   working_set    — process WorkingSet64 sampled at runtime-ready
 * Reports median / p95 over the runs.
 *
 * NOTE on scope: spec 1.3's headline budget is "main window usable <= 5 s".
 * The desktop window measurement under automation hits Tauri single-instance
 * and WebView2 user-data-folder locks that make scripted launches diverge
 * from interactive ones (REFACTOR_STATUS 29th pass, honest scope notes);
 * this driver measures the runtime-owned milestone reliably.
 *
 * Usage:
 *   node scripts/cold-start-baseline.mjs [runs]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const RUNS = Number(process.argv[2] || 10)
const PORT = 48099
const BASE = `http://127.0.0.1:${PORT}`
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.join(REPO, '.dsh-coldstart')
const HOME = path.join(ROOT, 'home')
const WORKSPACE = path.join(ROOT, 'workspace')
const BINARY = path.join(REPO, 'frontend', 'terminal', 'target', 'debug', 'hakus-tui.exe')

function httpJson(method, urlPath, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const req = http.request(`${BASE}${urlPath}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: timeoutMs,
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
    req.on('timeout', () => req.destroy(new Error('timeout')))
    if (data) req.write(data)
    req.end()
  })
}

async function waitHealth(timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return true
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

function killRuntime() {
  try { execFileSync('taskkill', ['/F', '/IM', 'hakus-tui.exe'], { stdio: 'ignore' }) } catch { /* none */ }
}

function waitPortFree(timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    try {
      const lines = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' })
      if (!lines.split('\n').some((l) => l.includes(`:${PORT} `) && l.includes('LISTENING'))) return true
    } catch { return true }
  }
  return false
}

// ---------------------------------------------------------------- setup
fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(HOME, { recursive: true })
fs.mkdirSync(WORKSPACE, { recursive: true })
fs.writeFileSync(path.join(HOME, 'config.toml'), `provider = "local"
default_text_model = "baseline"

allow_shell = false
approval_policy = "never"
sandbox_mode = "workspace-write"

[providers.local]
kind = "openai-compatible"
display_name = "Baseline stub (never called)"
api_key = "baseline-key"
base_url = "http://127.0.0.1:1/v1"
model = "baseline"
wire = "openai"
models = ["baseline"]

[update]
check_for_updates = false
`, 'utf8')

const launches = []
console.log(`== Cold-start baseline: ${RUNS} launches ==`)
try {
  for (let i = 1; i <= RUNS; i++) {
    killRuntime()
    waitPortFree(15)

    const started = Date.now()
    const proc = spawn(BINARY, ['serve', '--http', '--insecure', '--port', String(PORT)], {
      cwd: WORKSPACE,
      env: { ...process.env, HAKUS_HOME: HOME, DEEPSEEK_HOME: HOME },
      stdio: ['ignore', fs.openSync(path.join(ROOT, `run-${i}.out`), 'w'), fs.openSync(path.join(ROOT, `run-${i}.err`), 'w')],
    })

    const ready = await waitHealth(60)
    const readyMs = ready ? Date.now() - started : null
    let firstEventMs = null
    let workingSetMb = null

    if (ready) {
      // Working set of the runtime process (tasklist reports KB).
      try {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${proc.pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
        const m = out.match(/"([\d.,]+)\s*K"/)
        if (m) workingSetMb = Math.round((Number(m[1].replace(/[.,]/g, '')) / 1024) * 10) / 10
      } catch { workingSetMb = null }

      const t0 = Date.now()
      try {
        const created = await httpJson('POST', '/v1/threads', { title: 'baseline', mode: 'agent', archived: false })
        const tid = created.json?.id
        const evDeadline = Date.now() + 15000
        while (Date.now() < evDeadline) {
          const ledger = await httpJson('GET', `/v1/threads/${tid}/ledger?limit=10`)
          if (ledger.json?.verification?.last_seq >= 1) { firstEventMs = Date.now() - t0; break }
          await new Promise((r) => setTimeout(r, 20))
        }
      } catch { /* recorded as null */ }
    }

    launches.push({ run: i, exited_early: proc.exitCode !== null && ready === false, runtime_ready_ms: readyMs, first_event_ms: firstEventMs, working_set_mb: workingSetMb })
    console.log(`  run ${String(i).padStart(2)}: ready=${readyMs}ms first_event=${firstEventMs}ms ws=${workingSetMb}MB`)
    try { proc.kill() } catch { }
    killRuntime()
    waitPortFree(15)
  }
} catch (e) {
  console.error('DRIVER ERROR:', e.message)
} finally {
  killRuntime()
  await new Promise((r) => setTimeout(r, 500))
}

function stats(values) {
  const sorted = values.filter((v) => v !== null && v !== undefined).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return {
    n: sorted.length,
    median: sorted[Math.floor((sorted.length - 1) / 2)],
    p95: sorted[Math.min(sorted.length, Math.ceil(sorted.length * 0.95)) - 1],
    max: sorted[sorted.length - 1],
  }
}

const summary = {
  runs: RUNS,
  binary: BINARY,
  profile: 'debug',
  runtime_ready: stats(launches.map((l) => l.runtime_ready_ms)),
  first_event: stats(launches.map((l) => l.first_event_ms)),
  working_set_mb: stats(launches.map((l) => l.working_set_mb)),
  launches,
}
fs.writeFileSync(path.join(ROOT, 'baseline.json'), JSON.stringify(summary, null, 2))
console.log(`\nruntime_ready: median=${summary.runtime_ready?.median}ms p95=${summary.runtime_ready?.p95}ms (budget 5000ms)`)
console.log(`first_event: median=${summary.first_event?.median}ms p95=${summary.first_event?.p95}ms (budget 300ms)`)
console.log(`working_set_mb: median=${summary.working_set_mb?.median} p95=${summary.working_set_mb?.p95} (budget 450MB)`)
