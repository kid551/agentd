import type { AgentdClient } from './client.js'

// Router-side approval for a Worker's refused tool calls. Workers run in auto
// mode; when its classifier refuses a call, the Worker's PermissionDenied hook
// turns the refusal into a permission question for the person and waits. An
// approval makes the daemon hold a one-time grant for exactly that call and the
// hook tells the Worker it may retry; the Worker's PreToolUse hook lets the
// retry through when the daemon confirms the grant. The daemon, not a file the
// Worker could write, decides what is granted (implementation-notes 偏差 13).

export type HookEvent = 'denied' | 'request' | 'pre'

export type HookInput = {
  tool_name?: string
  tool_input?: unknown
  /** PermissionDenied: why the classifier refused. */
  reason?: string
}

export type HookOutput = { hookSpecificOutput: Record<string, unknown> }

export const APPROVE = '批准'
export const REJECT = '拒绝'

/** How long an approval waits for its retry. */
export const GRANT_TTL_MS = 10 * 60_000

const YES = new Set([
  '批准',
  '准奏',
  '准',
  '同意',
  '允许',
  '可以',
  '好',
  '行',
  'yes',
  'y',
  'ok',
  'approve',
  'allow',
])

/**
 * Only a plain yes approves: a reply that says anything else is a no, so a
 * misread answer never runs what the classifier refused.
 */
export function isApproval(answer: string): boolean {
  const flat = answer
    .trim()
    .toLowerCase()
    .replace(/[\s。.!！~～]+$/u, '')
  if (YES.has(flat)) return true
  return /^(批准|准奏)[\s，,。.!！；;：:]/u.test(flat)
}

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map(key => [key, stable((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

/**
 * Names one tool call. `description` is left out: the model rewrites a Bash
 * call's description freely, and it changes nothing the call does.
 */
export function grantKey(toolName: string, toolInput: unknown): string {
  const input =
    toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
      ? Object.fromEntries(
          Object.entries(toolInput as Record<string, unknown>).filter(([k]) => k !== 'description'),
        )
      : toolInput
  return `${toolName} ${JSON.stringify(stable(input))}`
}

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text

/** What the call would do, in the words a person checks before approving. */
function callText(toolName: string, toolInput: unknown): string {
  const input = (toolInput ?? {}) as Record<string, unknown>
  const pick = (key: string): string | null =>
    typeof input[key] === 'string' ? (input[key] as string) : null
  const main = pick('command') ?? pick('file_path') ?? pick('url') ?? pick('path')
  const body = main ?? JSON.stringify(toolInput ?? {}, null, 2)
  return `\`\`\`\n${clip(body, 1500)}\n\`\`\``
}

export function permissionQuestion(event: 'denied' | 'request', input: HookInput): string {
  const tool = input.tool_name ?? '未知工具'
  const lines = [
    `**权限请求**：Worker 想用 \`${tool}\` 做这件事——`,
    callText(tool, input.tool_input),
  ]
  if (event === 'denied' && input.reason) {
    lines.push(`自动审查拒绝了它，理由：${clip(input.reason.trim(), 300)}`)
  }
  if (typeof (input.tool_input as { description?: unknown })?.description === 'string') {
    lines.push(
      `Worker 的说明：${clip((input.tool_input as { description: string }).description, 200)}`,
    )
  }
  lines.push('批准这一次吗？')
  return lines.join('\n\n')
}

/** POSIX single quotes: the one quoting a shell never expands inside. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

export type HookSetup = {
  node: string
  script: string
  url: string
  ticket: number
  /** A file the daemon keeps while it holds grants for this ticket. */
  flag: string
}

/**
 * The `--settings` value that wires a Worker's hooks to agentd. PreToolUse runs
 * before every tool call, so it costs one file test until a grant exists. The
 * other two wait for a person, so their timeout is a day, not a minute.
 */
export function workerSettings(s: HookSetup): string {
  const env = `AGENTD_URL=${shellQuote(s.url)} AGENTD_TICKET=${s.ticket}`
  const run = (event: HookEvent): string =>
    `${env} exec ${shellQuote(s.node)} ${shellQuote(s.script)} ${event}`
  const hook = (command: string, timeout: number) => [
    { matcher: '*', hooks: [{ type: 'command', command, timeout }] },
  ]
  return JSON.stringify({
    hooks: {
      PermissionDenied: hook(run('denied'), 86_400),
      PermissionRequest: hook(run('request'), 86_400),
      PreToolUse: hook(`if [ -e ${shellQuote(s.flag)} ]; then ${run('pre')}; fi`, 30),
    },
  })
}

export type HookDeps = {
  client: AgentdClient
  ticket: number
  /** Each wait for an answer, in seconds; the daemon caps it at 30. */
  waitSeconds?: number
  retryMs?: number
}

type Wait = { answered: boolean; answer: string | null; withdrawn: boolean }

/** Asks the person and waits; null when the question could not be asked or was withdrawn. */
async function askPerson(
  deps: HookDeps,
  event: 'denied' | 'request',
  input: HookInput,
): Promise<string | null> {
  const tool = input.tool_name ?? ''
  let qid: number
  try {
    const asked = await deps.client.post<{ ok: boolean; questionId?: number }>(
      `/tickets/${deps.ticket}/ask`,
      {
        question: permissionQuestion(event, input),
        options: [APPROVE, REJECT],
        kind: 'permission',
        // Only a refusal needs a grant: a permission prompt is answered in place.
        ...(event === 'denied' ? { grantKey: grantKey(tool, input.tool_input) } : {}),
      },
    )
    if (!asked.data.ok || asked.data.questionId === undefined) return null
    qid = asked.data.questionId
  } catch {
    return null
  }
  // Like the MCP ask: a daemon restart between polls loses nothing.
  for (;;) {
    try {
      const r = await deps.client.get<Wait>(`/questions/${qid}?wait=${deps.waitSeconds ?? 25}`)
      if (r.data.answered) return r.data.answer ?? ''
      if (r.data.withdrawn) return null
    } catch {
      await new Promise(resolve => setTimeout(resolve, deps.retryMs ?? 3000))
    }
  }
}

/** One hook run: what to print on stdout, or null to print nothing and change nothing. */
export async function runHook(
  event: HookEvent,
  input: HookInput,
  deps: HookDeps,
): Promise<HookOutput | null> {
  if (event === 'pre') {
    try {
      const r = await deps.client.post<{ granted: boolean }>(
        `/tickets/${deps.ticket}/grants/take`,
        {
          key: grantKey(input.tool_name ?? '', input.tool_input),
        },
      )
      if (!r.data.granted) return null
    } catch {
      return null
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: '用户已在 Router 批准这一次',
      },
    }
  }

  const answer = await askPerson(deps, event, input)
  const approved = answer !== null && isApproval(answer)
  if (event === 'denied') {
    // No output leaves the refusal as it was; the Worker prompt says what then.
    return approved
      ? { hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true } }
      : null
  }
  // A permission prompt in a background session has nobody to show it to, so
  // anything but an approval is a deny that says why.
  const message =
    answer === null ? 'agentd 没能把这个权限请求转给用户（或已撤回）。' : `用户没有批准：${answer}`
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: approved ? { behavior: 'allow' } : { behavior: 'deny', message },
    },
  }
}
