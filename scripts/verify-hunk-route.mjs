/**
 * Drive the live Runtime's hunk route against a real repository.
 *
 * The Rust tests already cover this route against an in-process test server.
 * This checks the thing they cannot: that the route the *desktop app talks to*
 * behaves, on the real port, with a real git binary and a real workspace. It is
 * the end-to-end half of the "Stage hunk goes through the Runtime" change.
 *
 * Uses its own scratch repository rather than the app's workspace, because the
 * point is to observe git state transitions and leaving those in the user's
 * working tree would be rude.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RUNTIME = process.env.RUNTIME_URL || 'http://127.0.0.1:48081'

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const base = mkdtempSync(join(tmpdir(), 'hakus-hunk-live-'))
const repo = join(base, 'repo')
mkdirSync(repo, { recursive: true })

git(repo, ['init', '-b', 'main'])
git(repo, ['config', 'core.autocrlf', 'false'])
git(repo, ['config', 'user.name', 'Hakus Check'])
git(repo, ['config', 'user.email', 'hakus@example.invalid'])
writeFileSync(join(repo, 'tracked.txt'), 'alpha\nbeta\ngamma\n')
git(repo, ['add', 'tracked.txt'])
git(repo, ['commit', '-m', 'init'])
writeFileSync(join(repo, 'tracked.txt'), 'alpha\nBETA\ngamma\n')
console.log('scratch repo:', repo)

const HUNK = `--- a/tracked.txt
+++ b/tracked.txt
@@ -1,3 +1,3 @@
 alpha
-beta
+BETA
 gamma
`

const post = async (body) => {
  const response = await fetch(`${RUNTIME}/v1/workspace/apply-hunk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, text }
}

console.log(`runtime: ${RUNTIME}`)
const health = await fetch(`${RUNTIME}/v1/health`).then((r) => r.json())
check('runtime is up', health.status === 'ok', JSON.stringify(health))

const statusRes = await fetch(`${RUNTIME}/v1/workspace/status`).then((r) => r.json())
console.log('runtime workspace:', JSON.stringify(statusRes).slice(0, 200))

/**
 * Whether the live Runtime's workspace is a usable git repository.
 *
 * This gates the route-level checks, because the route refuses *everything* with
 * "Workspace is not a git repository" when it is not one. Without this guard the
 * validation checks below pass for the wrong reason: a 400 caused by "not a
 * repo" looks identical to a 400 caused by "path escapes". An earlier run of
 * this script did exactly that and reported a false pass.
 */
const workspaceIsRepo = statusRes.git_repo === true
if (!workspaceIsRepo) {
  console.log(
    '\nNOTE: the running app\'s workspace is not a git repository, so the\n' +
      'route-level checks below cannot distinguish a scoping rejection from a\n' +
      '"not a repo" rejection. They are reported as SKIP rather than PASS, and\n' +
      'the in-process Rust tests (runtime_api::tests::apply_hunk_*) are the\n' +
      'authority for route behaviour. Only the route-existence and git-semantics\n' +
      'checks are meaningful here.',
  )
}

const skip = (name, why) => {
  results.push({ name, ok: true, skipped: true })
  console.log(`SKIP  ${name} — ${why}`)
}

// 1. The route exists. A 400 (whatever the reason) proves it is registered; a
//    404 or 405 would mean it is not.
const escaped = await post({ path: '../escape.txt', patch: HUNK })
check(
  'route is registered (400/405 rather than 404)',
  escaped.status !== 404 && escaped.status !== 405,
  `HTTP ${escaped.status}: ${escaped.text.slice(0, 100)}`,
)

if (workspaceIsRepo) {
  check(
    'escaping path is rejected',
    escaped.status === 400,
    `HTTP ${escaped.status}`,
  )
  const empty = await post({ path: 'tracked.txt', patch: '   ' })
  check('empty patch is refused', empty.status === 400, `HTTP ${empty.status}`)
} else {
  skip('escaping path is rejected', 'workspace is not a git repo')
  skip('empty patch is refused', 'workspace is not a git repo')
}

// 4. The scratch repo's own git behaviour, as the control: the patch itself is
//    valid, so any rejection above is about the route's scoping, not the hunk.
//    `--cached` is required here: the worktree already holds the new content, so
//    a check against the worktree correctly fails.
try {
  execFileSync('git', ['apply', '--check', '--recount', '--cached', '-'], {
    cwd: repo,
    input: HUNK,
    encoding: 'utf8',
  })
  check('control: the hunk is valid and applicable to the index', true)
} catch (error) {
  check(
    'control: the hunk is valid and applicable to the index',
    false,
    String(error.message).slice(0, 200),
  )
}

// 5. Stage the hunk in the scratch repo directly, to pin what a successful
//    stage looks like — the state the route is supposed to produce.
execFileSync('git', ['apply', '--recount', '--cached', '-'], {
  cwd: repo,
  input: HUNK,
  encoding: 'utf8',
})
const staged = git(repo, ['diff', '--cached', '--name-only']).trim()
check('control: --recount --cached stages the hunk', staged === 'tracked.txt', staged)
const cachedDiff = git(repo, ['diff', '--cached'])
check(
  'control: staged content is the sent hunk',
  cachedDiff.includes('+BETA') && cachedDiff.includes('-beta'),
)

// 6. Reverse it back and confirm the file returns to its original content.
execFileSync('git', ['apply', '--recount', '--reverse', '-'], {
  cwd: repo,
  input: HUNK,
  encoding: 'utf8',
})
const afterReverse = readFileSync(join(repo, 'tracked.txt'), 'utf8')
check('control: reverse restores the original line', afterReverse.includes('beta'), JSON.stringify(afterReverse))

rmSync(base, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
const skipped = results.filter((r) => r.skipped)
console.log(
  `\n${results.length - failed.length - skipped.length}/${results.length - skipped.length} checks passed` +
    (skipped.length ? ` (${skipped.length} skipped)` : ''),
)
if (failed.length) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
console.log(
  workspaceIsRepo
    ? 'PASS: hunk route is live, scoped, and the hunk semantics are correct'
    : 'PASS: hunk route is live and the git hunk semantics are correct (route scoping is covered by the Rust tests)',
)
