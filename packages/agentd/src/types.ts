// Shapes shared by the daemon, its HTTP API, the Worker-side MCP server and the
// CLI. The router mod keeps its own copy of the API shapes it reads (a mod may
// import nothing from npm), in packages/router-mod/hooks/api.ts.

export const TICKET_STATES = [
  'queued',
  'working',
  'asking',
  'ready',
  'blocked',
  'failed',
  'done',
  'stopped',
] as const
export type TicketState = (typeof TICKET_STATES)[number]

/** States that wait for the person: the Pane's「待我处理」group. */
export const NEEDS_ME: readonly TicketState[] = ['asking', 'ready', 'blocked', 'failed']
/** States whose Worker is expected to be running a turn. */
export const ACTIVE: readonly TicketState[] = ['working', 'asking']
/**
 * States with a Worker (live or stopped short of `close`/`stop`) that may still
 * hold uncommitted work in the project folder: one such ticket per project,
 * unless it writes in its own lane (worktree) or not at all (readonly).
 */
export const OCCUPYING: readonly TicketState[] = ['working', 'asking', 'ready', 'blocked', 'failed']
/** States no automatic input changes; `done` can still be reopened by a message. */
export const ENDED: readonly TicketState[] = ['done', 'stopped']

/** `merged`: an MR ticket's change is in main; only after the person asked for the MR. */
export type Outcome = 'ready' | 'blocked' | 'failed' | 'dropped' | 'merged'

export type EventKind =
  | 'dispatched'
  | 'spawned'
  | 'spawn_failed'
  | 'progress'
  | 'ask'
  | 'answer'
  | 'message'
  | 'ready'
  | 'blocked'
  | 'failed'
  | 'dropped'
  | 'stalled'
  | 'exited'
  | 'closed'
  | 'stopped'
  | 'reopened'
  | 'retried'
  | 'resumed'
  /** The person approved an MR ticket's change: the Worker opens the MR. */
  | 'mr_requested'
  | 'merged'
  /** The ticket's lane (worktree and branch) was removed. */
  | 'cleaned'
  /** The lane could not be removed safely, and was left for the person. */
  | 'kept'

export type Actor = 'you' | 'router' | 'worker' | 'agentd'

/** Event kinds the router mod hands to the Router model: someone must act. */
export const NOTIFY_KINDS: readonly EventKind[] = [
  'ask',
  'ready',
  'blocked',
  'failed',
  'dropped',
  'stalled',
  'exited',
  'spawn_failed',
  'merged',
  'kept',
]

export type Project = {
  id: string
  path: string
  root: string
}

/** `permission`: agentd asks on a Worker's behalf whether one refused tool call may run. */
export type QuestionKind = 'ask' | 'permission'

export type Question = {
  id: number
  ticketId: number
  kind: QuestionKind
  question: string
  options: string[] | null
  askedAt: number
  answeredAt: number | null
  answer: string | null
}

export type TicketView = {
  id: number
  title: string
  project: string
  cwd: string
  state: TicketState
  needsMe: boolean
  model: string
  /** Writes in its own lane and goes to main through an MR (the project's delivery is `mr`). */
  worktree: boolean
  /** Looks, never writes: runs in plan mode, holds no project. */
  readonly: boolean
  /** The lane, once made; null again after it is cleaned. */
  branch: string | null
  worktreePath: string | null
  /** The project's main checkout the lane belongs to. */
  repoPath: string | null
  /** The person asked for the MR (`open_mr`). */
  mrOpened: boolean
  workerName: string
  workerSessionId: string | null
  workerBgId: string | null
  /**
   * The latest message the Worker or agentd sent the person: a report, a
   * question or permission request, a hand-in, a stall. Shown as 「最近消息」.
   */
  lastReport: string | null
  /**
   * The person's answer to `lastReport` when that is a question they answered,
   * cut; 批准 / 拒绝 for a permission request. Shown as 「你答：」 under it.
   */
  lastAnswer: string | null
  /** The earlier ticket this one carries on, as the Router said at dispatch. */
  followsId: number | null
  openQuestion: Question | null
  createdAt: number
  updatedAt: number
  endedAt: number | null
}

export type TicketHeader = { id: number; title: string; project: string }

export type EventView = {
  id: number
  ticketId: number
  ts: number
  kind: EventKind
  actor: Actor
  /** The event's text cut to the inline budget (Inline & Spill). */
  summary: string
  /** True when `summary` is cut; `GET /tickets/:id/events` holds the whole. */
  isCut: boolean
  /**
   * Feed only (`GET /events`): for a hand-back (ask, blocked, failed, stalled,
   * exited), the ticket's last progress report before it, cut to the same
   * budget. Null otherwise, and always null in `GET /tickets/:id/events`.
   */
  priorReport: string | null
  ticket: TicketHeader
}

export type DispatchInput = {
  project: string
  title: string
  prompt: string
  readonly?: boolean
  model?: string
  /** The earlier ticket this one carries on. */
  follows?: number
}

export type ResolveResult =
  | { kind: 'found'; project: Project }
  | { kind: 'ambiguous'; candidates: Project[] }
  | { kind: 'none'; suggestions: Project[] }

export type AnswerResult = { questionId: number; hadWaiter: boolean; workerName: string }

export type TranscriptRow = {
  role: 'user' | 'assistant'
  text: string
  tools: string[]
  /** The row's byte offset in the transcript file: its id, for reading it whole or paging before it. */
  at: number
  /** True when `text` is cut to the per-row budget. */
  isCut: boolean
}

/** Rows of a transcript, oldest first; `more` when older rows exist. */
export type TranscriptPage = { rows: TranscriptRow[]; more: boolean }
