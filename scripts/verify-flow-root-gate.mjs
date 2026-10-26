/**
 * End-to-end check of the Flow file-root gate, against the real Tauri commands.
 *
 * The unit tests in `flow_roots.rs` cover the decision function. This checks the
 * thing users actually hit: that `fs_write_text` is refused on an unconfirmed
 * root, allowed once confirmed, and that the confirmation is specific — a
 * sibling folder sharing a name prefix must still be refused, because that is
 * the exact bug a string-prefix containment check would introduce.
 *
 * Requires the desktop app running with remote debugging (CDP_PORT, default
 * 9223). Skipped with a clear message when the bridge is not reachable, rather
 * than reporting a false pass.
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from './cdp.mjs'

const PORT = Number(process.env.CDP_PORT || 9223)
const { cdp, page } = await connect(PORT)
console.log('attached:', page.title, '|', page.url)

// Real folders on this machine: a confirmed one, and a sibling whose path
// string begins with it.
const base = mkdtempSync(join(tmpdir(), 'hakus-gate-'))
const confirmedRoot = join(base, 'proj')
const siblingRoot = join(base, 'proj-secret')
const { mkdirSync } = await import('node:fs')
mkdirSync(confirmedRoot, { recursive: true })
mkdirSync(siblingRoot, { recursive: true })
console.log('base:', base)

const run = async (label, expr) => {
  const value = await cdp.evalIn(expr)
  console.log(`  ${label}: ${JSON.stringify(value)}`)
  return value
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// Drive the real commands through the exposed bridge module.
const bridge = `
  const b = await import('/src/api/tauriBridge.ts')
  b
`

const invoke = async (fn, args) =>
  cdp.evalIn(`
    (async () => {
      const b = await import('/src/api/tauriBridge.ts')
      try {
        const value = await b.${fn}(${args})
        return { ok: true, value }
      } catch (e) {
        return { ok: false, message: String(e?.message ?? e) }
      }
    })()
  `)

// 1. Unconfirmed root must be refused for writing.
const before = await invoke('fsOs.writeText', `'${esc(confirmedRoot)}', 'pwned.txt', 'should not land'`)
check(
  'unconfirmed root refuses a write',
  before.ok === false && String(before.message).includes('not confirmed'),
  JSON.stringify(before),
)
const landedBefore = existsSync(join(confirmedRoot, 'pwned.txt'))
check('no file was created while unconfirmed', landedBefore === false, `exists=${landedBefore}`)

// 2. Check reports false before confirmation, true after.
const checkBefore = await invoke('flowRoots.check', `'${esc(confirmedRoot)}', true`)
check('flow_root_check says false before confirming', checkBefore.value === false, JSON.stringify(checkBefore))

await invoke('flowRoots.confirm', `'${esc(confirmedRoot)}', true`)
const checkAfter = await invoke('flowRoots.check', `'${esc(confirmedRoot)}', true`)
check('flow_root_check says true after confirming', checkAfter.value === true, JSON.stringify(checkAfter))

// 3. Confirmed root now permits the write.
const after = await invoke('fsOs.writeText', `'${esc(confirmedRoot)}', 'ok.txt', 'gate passed'`)
check('confirmed root permits the write', after.ok === true, JSON.stringify(after))
const landedAfter = existsSync(join(confirmedRoot, 'ok.txt'))
check('the write actually landed', landedAfter, `exists=${landedAfter}`)
if (landedAfter) {
  const body = readFileSync(join(confirmedRoot, 'ok.txt'), 'utf8')
  check('file content is intact', body === 'gate passed', JSON.stringify(body))
}

// 4. The sibling sharing a name prefix must STILL be refused.
const sibling = await invoke('fsOs.writeText', `'${esc(siblingRoot)}', 'pwned.txt', 'prefix escape'`)
check(
  'name-prefix sibling is still refused',
  sibling.ok === false && String(sibling.message).includes('not confirmed'),
  JSON.stringify(sibling),
)
const landedSibling = existsSync(join(siblingRoot, 'pwned.txt'))
check('no file created in the sibling', landedSibling === false, `exists=${landedSibling}`)

// 5. Read-only confirmation must not permit writing.
await invoke('flowRoots.confirm', `'${esc(siblingRoot)}', false`)
const readOnlyWrite = await invoke('fsOs.writeText', `'${esc(siblingRoot)}', 'pwned.txt', 'read-only breach'`)
check(
  'read-only root refuses a write',
  readOnlyWrite.ok === false && String(readOnlyWrite.message).includes('Read-only'),
  JSON.stringify(readOnlyWrite),
)
const readOnlyRead = await invoke('fsOs.listDir', `'${esc(siblingRoot)}', '.'`)
check('read-only root still permits a read', readOnlyRead.ok === true, JSON.stringify(readOnlyRead))

// 6. Revoking takes effect immediately.
await invoke('flowRoots.revoke', `'${esc(confirmedRoot)}'`)
const revoked = await invoke('fsOs.writeText', `'${esc(confirmedRoot)}', 'later.txt', 'after revoke'`)
check('a revoked root is refused again', revoked.ok === false, JSON.stringify(revoked))

// 7. Dangerous roots are refused outright, even if the operator says yes.
const home = await cdp.evalIn('navigator.userAgent.includes("Windows")')
const dangerous = await invoke('flowRoots.confirm', home ? `'C:\\\\', true` : `'/', true`)
check('a filesystem root cannot be confirmed', dangerous.ok === false, JSON.stringify(dangerous))

rmSync(base, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
console.log('PASS: Flow file-root gate behaves as specified')
process.exit(0)

function esc(path) {
  return path.replace(/\\/g, '\\\\')
}
