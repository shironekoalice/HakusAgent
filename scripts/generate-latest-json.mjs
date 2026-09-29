#!/usr/bin/env node
/**
 * Assemble a Tauri updater manifest (`latest.json`) from signed bundle
 * artifacts.
 *
 * Why this exists instead of relying on the bundler's own manifest: each
 * platform's bundler run only knows its own artifacts, while the release
 * serves one merged manifest from a fixed-tag URL baked into the client.
 * Assembling it from the collected signed artifacts keeps every platform
 * entry in sync with what actually shipped.
 *
 * The scan is driven by `.sig` sidecars rather than a hardcoded filename list:
 * the bundler's artifact names vary by platform, version and target triple, and
 * every updater artifact is signed, so the signatures are the reliable index.
 *
 * Usage:
 *   node scripts/generate-latest-json.mjs \
 *     --version 0.3.0 \
 *     --assets-dir release-assets \
 *     --base-url https://github.com/modemneko/HakusAgent/releases/download/stable \
 *     --out latest.json
 *
 * Platforms whose bundle or signature is missing are omitted rather than
 * emitted with an empty signature: the updater verifies signatures, so a bogus
 * entry would break installs on that platform while looking healthy upstream.
 */
import fs from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (!key?.startsWith('--')) throw new Error(`unexpected argument: ${key}`)
    out[key.slice(2)] = argv[i + 1]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const version = args.version
const assetsDir = args['assets-dir'] ?? 'release-assets'
const baseUrl = (args['base-url'] ?? '').replace(/\/$/, '')
const outPath = args.out ?? 'latest.json'
const notes = args.notes ?? ''

if (!version) throw new Error('--version is required')
if (!baseUrl) throw new Error('--base-url is required')
if (!fs.existsSync(assetsDir)) throw new Error(`assets dir not found: ${assetsDir}`)

/**
 * Map a signed bundle's filename to the target key the updater looks up.
 *
 * Keys follow the plugin's `{os}-{arch}` convention (`updater_os()` returns
 * `linux` / `darwin` / `windows`; `updater_arch()` returns `x86_64` /
 * `aarch64`). Order matters: `.app.tar.gz` must be tested before the generic
 * archive patterns, and arch is checked before the os default.
 */
const PLATFORM_PATTERNS = [
  { key: 'windows-x86_64', test: (f) => /(x64|amd64).*setup\.exe$/i.test(f) || /(x64|amd64).*\.msi$/i.test(f) },
  { key: 'windows-aarch64', test: (f) => /arm64.*setup\.exe$/i.test(f) },
  { key: 'darwin-aarch64', test: (f) => /(aarch64|arm64|universal).*\.app\.tar\.gz$/i.test(f) },
  { key: 'darwin-x86_64', test: (f) => /(x64|x86_64).*\.app\.tar\.gz$/i.test(f) },
  { key: 'darwin-aarch64', test: (f) => /\.app\.tar\.gz$/i.test(f) && /aarch64|arm64/i.test(f) },
  { key: 'darwin-x86_64', test: (f) => /\.app\.tar\.gz$/i.test(f) && !/aarch64|arm64|universal/i.test(f) },
  { key: 'linux-aarch64', test: (f) => /(aarch64|arm64).*\.AppImage$/i.test(f) },
  { key: 'linux-x86_64', test: (f) => /\.AppImage$/i.test(f) },
]

function platformKeyFor(bundleName) {
  for (const { key, test } of PLATFORM_PATTERNS) {
    if (test(bundleName)) return key
  }
  return null
}

const allFiles = fs.readdirSync(assetsDir)
const sigFiles = allFiles.filter((f) => f.endsWith('.sig'))

if (sigFiles.length === 0) {
  throw new Error(
    `no .sig files in ${assetsDir}. Is TAURI_SIGNING_PRIVATE_KEY set? ` +
      `createUpdaterArtifacts only emits signatures when the key is available.`,
  )
}

const platforms = {}
const unmatched = []

for (const sigFile of sigFiles) {
  // "Foo_0.3.0_x64-setup.exe.sig" -> "Foo_0.3.0_x64-setup.exe"
  const bundleName = sigFile.slice(0, -'.sig'.length)
  if (!allFiles.includes(bundleName)) {
    unmatched.push(`${sigFile} (bundle missing)`)
    continue
  }
  const key = platformKeyFor(bundleName)
  if (!key) {
    unmatched.push(`${bundleName} (unrecognized platform)`)
    continue
  }
  const signature = fs.readFileSync(path.join(assetsDir, sigFile), 'utf8').trim()
  if (!signature) {
    unmatched.push(`${bundleName} (empty signature)`)
    continue
  }
  if (platforms[key]) {
    throw new Error(
      `multiple updater bundles matched ${key}: ${platforms[key].url} and ${bundleName}`,
    )
  }
  platforms[key] = {
    signature,
    url: `${baseUrl}/${encodeURIComponent(bundleName)}`,
  }
}

const found = Object.keys(platforms)
if (found.length === 0) {
  throw new Error(
    `found ${sigFiles.length} signature(s) but none matched a known platform: ${unmatched.join(', ')}`,
  )
}

const manifest = {
  version,
  notes: notes || `HakusAI v${version}`,
  pub_date: new Date().toISOString(),
  platforms,
}

fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote ${outPath} with ${found.length} platform(s):`)
for (const key of found) console.log(`  ${key} -> ${platforms[key].url}`)
if (unmatched.length > 0) {
  // Loud but non-fatal: a skipped artifact is a platform whose users will not
  // be offered this update, which must be visible in the CI log.
  console.log(`not used: ${unmatched.join(', ')}`)
}
