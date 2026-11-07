import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { TranscriptPage, TranscriptRow } from './types.js'

export function projectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
}

const found = new Map<string, string>()

/**
 * Finds a session's transcript by id. The folder a session's transcript lands
 * in is not always its cwd spelled as a folder name, so every folder is looked
 * in (implementation-notes S1-3).
 */
export function findTranscript(sessionId: string, dir = projectsDir()): string | null {
  const cached = found.get(sessionId)
  if (cached && existsSync(cached)) return cached
  let folders: string[]
  try {
    folders = readdirSync(dir)
  } catch {
    return null
  }
  for (const folder of folders) {
    const file = join(dir, folder, `${sessionId}.jsonl`)
    if (existsSync(file)) {
      found.set(sessionId, file)
      return file
    }
  }
  return null
}

/** Reads the last `bytes` of a file as text, from the first whole line. */
function tail(file: string, bytes: number): string {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8')
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1)
  } finally {
    closeSync(fd)
  }
}

type Block = { type?: string; text?: string; name?: string }

/** One transcript line as a row a person would read; null for meta, tool results and the like. */
function parseRow(line: string, at: number, charsPerRow: number): TranscriptRow | null {
  if (!line.trim()) return null
  let entry: { type?: string; isMeta?: boolean; message?: { content?: string | Block[] } }
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta) return null
  const content = entry.message?.content
  const blocks: Block[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? [])
  const text = blocks
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text as string)
    .join('\n')
    .trim()
  const tools = blocks.filter(b => b.type === 'tool_use' && b.name).map(b => b.name as string)
  if (!text && tools.length === 0) return null
  return {
    role: entry.type,
    text: text.slice(0, charsPerRow),
    tools,
    at,
    isCut: text.length > charsPerRow,
  }
}

const CHUNK = 1024 * 1024

/**
 * The conversation's last `limit` rows a person would read (prompts, answers,
 * tool names) ending before byte `before`, each cut to `charsPerRow`. Reads the
 * file backwards a chunk at a time until it has them. A line longer than a
 * chunk (a huge tool result) is skipped: it holds nothing shown here.
 */
export function readRows(
  file: string,
  options: { limit?: number; before?: number; charsPerRow?: number } = {},
): TranscriptPage {
  const limit = options.limit ?? 20
  const charsPerRow = options.charsPerRow ?? 600
  const fd = openSync(file, 'r')
  try {
    let stop = Math.min(options.before ?? Infinity, fstatSync(fd).size)
    let rows: TranscriptRow[] = []
    while (stop > 0 && rows.length <= limit) {
      const start = Math.max(0, stop - CHUNK)
      const buffer = Buffer.alloc(stop - start)
      readSync(fd, buffer, 0, buffer.length, start)
      // Before the first newline is the end of a line the next chunk back holds.
      const from = start === 0 ? 0 : buffer.indexOf(0x0a) + 1
      // No line starts in this chunk: it is the middle of a line longer than a chunk.
      if (start > 0 && (from === 0 || from === buffer.length)) {
        stop = start
        continue
      }
      const found: TranscriptRow[] = []
      for (let i = from; i < buffer.length;) {
        const nl = buffer.indexOf(0x0a, i)
        const j = nl === -1 ? buffer.length : nl
        const row = parseRow(buffer.toString('utf8', i, j), start + i, charsPerRow)
        if (row) found.push(row)
        i = j + 1
      }
      rows = [...found, ...rows]
      stop = start + from
    }
    return { rows: rows.slice(-limit), more: rows.length > limit }
  } finally {
    closeSync(fd)
  }
}

/** The whole row starting at byte `at`; null when no row a person would read starts there. */
export function readRow(file: string, at: number): TranscriptRow | null {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    if (!Number.isInteger(at) || at < 0 || at >= size) return null
    if (at > 0) {
      const prev = Buffer.alloc(1)
      readSync(fd, prev, 0, 1, at - 1)
      if (prev[0] !== 0x0a) return null
    }
    const parts: Buffer[] = []
    for (let pos = at; pos < size;) {
      const buffer = Buffer.alloc(Math.min(CHUNK, size - pos))
      readSync(fd, buffer, 0, buffer.length, pos)
      const nl = buffer.indexOf(0x0a)
      parts.push(nl === -1 ? buffer : buffer.subarray(0, nl))
      if (nl !== -1) break
      pos += buffer.length
    }
    return parseRow(Buffer.concat(parts).toString('utf8'), at, Infinity)
  } finally {
    closeSync(fd)
  }
}

type ToolBlock = { type?: string; text?: string; name?: string; input?: Record<string, unknown> }

/** The one argument that says what a tool call is doing. */
function toolLine(block: ToolBlock): string {
  const input = block.input ?? {}
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = input[key]
      if (typeof value === 'string' && value.trim()) return value
    }
    return ''
  }
  const name = (block.name ?? '').replace(/^mcp__.+?__/, '')
  const arg = pick(
    'description',
    'command',
    'file_path',
    'pattern',
    'url',
    'query',
    'summary',
    'question',
  )
  return arg ? `${name} ${arg}` : name
}

const oneLine = (text: string, chars: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > chars ? `${line.slice(0, chars - 1)}…` : line
}

export type Activity = { lines: string[]; at: number | null }

const activityCache = new Map<string, { size: number; activity: Activity }>()

/**
 * What a Worker did last, as a person glancing at it would read it: its last
 * `limit` lines of words or tool calls, and when the newest was written. Only
 * the file's end is read, and an unchanged file is not read again.
 */
export function readActivity(file: string, limit = 2, charsPerLine = 120): Activity {
  const size = statSync(file).size
  const key = `${file}\n${limit}\n${charsPerLine}`
  const cached = activityCache.get(key)
  if (cached?.size === size) return cached.activity
  const lines: string[] = []
  let at: number | null = null
  for (const line of tail(file, 256 * 1024).split('\n')) {
    if (!line.trim()) continue
    let entry: {
      type?: string
      timestamp?: string
      message?: { content?: string | ToolBlock[] }
    }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type !== 'assistant') continue
    const content = entry.message?.content
    const blocks: ToolBlock[] =
      typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? [])
    for (const block of blocks) {
      const text =
        block.type === 'text' && block.text?.trim()
          ? block.text
          : block.type === 'tool_use' && block.name
            ? `▸ ${toolLine(block)}`
            : ''
      if (!text) continue
      lines.push(oneLine(text, charsPerLine))
      const time = entry.timestamp ? Date.parse(entry.timestamp) : NaN
      if (!Number.isNaN(time)) at = time
    }
  }
  const activity = { lines: lines.slice(-limit), at }
  activityCache.set(key, { size, activity })
  return activity
}
