/**
 * Unified-diff hunk helpers: parse + build a single-hunk patch that
 * `git apply --recount` (via the Rust Runtime's `POST /v1/workspace/apply-hunk`)
 * can stage or reverse.
 */

export interface ParsedDiffLine {
  type: 'context' | 'add' | 'del' | 'hunk' | 'meta'
  content: string
  oldNo?: number
  newNo?: number
}

export interface ParsedHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  header: string
  lines: ParsedDiffLine[]
  /** Raw hunk body lines including the @@ header. */
  rawLines: string[]
}

export interface ParsedFileDiff {
  path: string
  oldPath: string
  isNew: boolean
  isDeleted: boolean
  hunks: ParsedHunk[]
  /** Full file-level headers (diff --git / index / --- / +++). */
  headers: string[]
  raw: string
}

export function parseDiff(diff: string): ParsedFileDiff[] {
  if (!diff || !diff.trim()) return []
  const files: ParsedFileDiff[] = []
  const lines = diff.split('\n')
  let current: ParsedFileDiff | null = null
  let currentHunk: ParsedHunk | null = null
  let oldNo = 0
  let newNo = 0

  const pushHunk = () => {
    if (current && currentHunk) current.hunks.push(currentHunk)
    currentHunk = null
  }
  const pushFile = () => {
    pushHunk()
    if (current) files.push(current)
    current = null
  }

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      pushFile()
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
      const oldPath = m?.[1] || ''
      const path = m?.[2] || oldPath || line
      current = {
        path,
        oldPath: oldPath || path,
        isNew: false,
        isDeleted: false,
        hunks: [],
        headers: [line],
        raw: line + '\n',
      }
    } else if (!current) {
      continue
    } else if (line.startsWith('new file mode')) {
      current.isNew = true
      current.headers.push(line)
      current.raw += line + '\n'
    } else if (line.startsWith('deleted file mode')) {
      current.isDeleted = true
      current.headers.push(line)
      current.raw += line + '\n'
    } else if (
      line.startsWith('index ') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename from') ||
      line.startsWith('rename to') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode')
    ) {
      current.headers.push(line)
      current.raw += line + '\n'
    } else if (line.startsWith('--- ')) {
      current.headers.push(line)
      current.raw += line + '\n'
    } else if (line.startsWith('+++ ')) {
      current.headers.push(line)
      current.raw += line + '\n'
    } else if (line.startsWith('@@')) {
      pushHunk()
      const m = line.match(/@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/)
      oldNo = m ? parseInt(m[1], 10) : 0
      newNo = m ? parseInt(m[3], 10) : 0
      const oldCount = m?.[2] != null ? parseInt(m[2], 10) : 1
      const newCount = m?.[4] != null ? parseInt(m[4], 10) : 1
      currentHunk = {
        oldStart: oldNo,
        oldCount,
        newStart: newNo,
        newCount,
        header: line,
        lines: [{ type: 'hunk', content: line }],
        rawLines: [line],
      }
      current.raw += line + '\n'
    } else if (currentHunk) {
      currentHunk.rawLines.push(line)
      current.raw += line + '\n'
      if (line.startsWith('+')) {
        currentHunk.lines.push({ type: 'add', content: line.slice(1), newNo: newNo++ })
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({ type: 'del', content: line.slice(1), oldNo: oldNo++ })
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push({
          type: 'context',
          content: line.slice(1),
          oldNo: oldNo++,
          newNo: newNo++,
        })
      } else if (line.startsWith('\\')) {
        currentHunk.lines.push({ type: 'meta', content: line })
      }
    } else {
      current.raw += line + '\n'
    }
  }
  pushFile()
  return files
}

/**
 * Build a standalone unified-diff patch for one hunk.
 * `reverse=true` flips +/- so `git apply -R` can undo that hunk.
 */
export function buildHunkPatch(file: ParsedFileDiff, hunk: ParsedHunk, reverse = false): string {
  const oldPath = file.isNew ? '/dev/null' : `a/${file.oldPath}`
  const newPath = file.isDeleted ? '/dev/null' : `b/${file.path}`
  const out: string[] = []
  const gitLine = file.headers.find((h) => h.startsWith('diff --git'))
  if (gitLine) out.push(gitLine)
  for (const h of file.headers) {
    if (h === gitLine) continue
    if (h.startsWith('---') || h.startsWith('+++')) continue
    out.push(h)
  }
  out.push(`--- ${oldPath}`)
  out.push(`+++ ${newPath}`)

  // Recompute hunk header after potential flip (counts stay the same).
  out.push(hunk.header)
  for (const raw of hunk.rawLines.slice(1)) {
    if (reverse) {
      if (raw.startsWith('+')) out.push('-' + raw.slice(1))
      else if (raw.startsWith('-')) out.push('+' + raw.slice(1))
      else out.push(raw)
    } else {
      out.push(raw)
    }
  }
  // git apply expects a trailing newline on the last line.
  return out.join('\n') + '\n'
}

/** Human-readable hunk label, e.g. "@@ -12,5 +12,7 @@". */
export function hunkLabel(hunk: ParsedHunk): string {
  return hunk.header.split('@@').slice(0, 2).join('@@') + '@@'
}
