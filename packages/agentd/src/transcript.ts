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

import type { TranscriptRow } from './types.js'

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

/** The conversation's last `limit` rows a person would read: prompts, answers, tool names. */
export function readTail(file: string, limit = 20, charsPerRow = 600): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  for (const line of tail(file, 1024 * 1024).split('\n')) {
    if (!line.trim()) continue
    let entry: { type?: string; isMeta?: boolean; message?: { content?: string | Block[] } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta) continue
    const content = entry.message?.content
    const blocks: Block[] =
      typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? [])
    const text = blocks
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text as string)
      .join('\n')
      .trim()
    const tools = blocks.filter(b => b.type === 'tool_use' && b.name).map(b => b.name as string)
    if (!text && tools.length === 0) continue
    rows.push({ role: entry.type, text: text.slice(0, charsPerRow), tools })
  }
  return rows.slice(-limit)
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
