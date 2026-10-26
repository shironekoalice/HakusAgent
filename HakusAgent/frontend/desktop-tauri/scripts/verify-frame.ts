/**
 * Verify a captured Runtime frame through the desktop's own translation.
 *
 * A frame captured from the live Runtime is fed through the same private
 * `runtimeEventToAgentEvent` the stream loop calls, so the result is what the
 * execution-plan card receives rather than what a mock assumes.
 *
 * The assertions are derived from the frame itself, not from any fixed fixture:
 * a different plan is a different capture, not a failure. What is checked is the
 * translation contract — the event name the client switches on, the legacy keys
 * present, and that per-row status survives.
 *
 *   npx tsx scripts/verify-frame.ts <frame.json>
 */
import { readFileSync } from 'node:fs'
import { HakusAIClient } from '../src/api/client'

const path = process.argv[2]
if (!path) {
  console.error('usage: verify-frame.ts <frame.json>')
  process.exit(2)
}

const raw = readFileSync(path, 'utf8')
// Strip a UTF-8 BOM: PowerShell's `Set-Content -Encoding UTF8` writes one, and
// `JSON.parse` rejects it, so a capture made on Windows must not read as corrupt.
const envelope = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
  console.error('frame must be a single JSON object (the SSE envelope)')
  process.exit(2)
}

// This is exactly how the stream loop calls the translator (client.ts:2389).
const eventName = envelope.event
const payload = envelope.payload || envelope

const client = new HakusAIClient('http://127.0.0.1:48081')
const translated = (client as any).runtimeEventToAgentEvent(eventName, payload)

const items = (translated?.items || []) as Array<{ status?: string; content?: string }>
const report = {
  captured_event_name: eventName,
  translated_event_type: translated?.event_type ?? null,
  completed: translated?.completed ?? null,
  total: translated?.total ?? null,
  current_task: translated?.current_task ?? null,
  phase: translated?.phase ?? null,
  detail: translated?.detail ?? null,
  items: items.map((item) => `${item.status}: ${item.content}`),
}

console.log(JSON.stringify(report, null, 2))

const failures: string[] = []
const sourceItems = Array.isArray(payload.items) ? payload.items : []

if (translated?.event_type !== 'task_progress') {
  failures.push(`event_type should be task_progress, got ${translated?.event_type}`)
}
// Counts must match the frame that produced them, whatever the plan was.
if (translated?.total !== sourceItems.length) {
  failures.push(`total ${translated?.total} != ${sourceItems.length} rows in the frame`)
}
if (items.length !== sourceItems.length) {
  failures.push(`items ${items.length} != ${sourceItems.length} rows in the frame`)
}
if (translated?.completed !== payload.completed) {
  failures.push(`completed ${translated?.completed} != ${payload.completed}`)
}
// Every row keeps its own status, which is the whole point of carrying `items`.
for (const [index, source] of sourceItems.entries()) {
  if (items[index]?.status !== source.status) {
    failures.push(`row ${index} status ${items[index]?.status} != ${source.status}`)
  }
  if (items[index]?.content !== source.content) {
    failures.push(`row ${index} content changed`)
  }
}
if (translated?.current_task !== (payload.current_task ?? '')) {
  failures.push(`current_task ${translated?.current_task} != ${payload.current_task}`)
}
// A client reading the legacy keys unconditionally must not get `undefined`.
if (translated?.phase !== '' || translated?.detail !== '') {
  failures.push('legacy phase/detail keys must be present and empty')
}

if (failures.length > 0) {
  console.error('\nFAIL:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(
  `\nPASS: the captured Runtime frame drives the execution-plan card ` +
    `(${translated.total} rows, ${translated.completed} settled).`,
)
