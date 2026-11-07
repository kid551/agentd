import type { EventKind, TicketState } from './state.js'

export type ModelRoute = { provider: string; model: string; reasoningEffort?: string }

export type Ticket = {
  id: number
  title: string
  /** The task text the Worker started from. */
  task: string
  /** v1 only dispatches dsh Sessions; the field keeps the executor seam open. */
  executor: 'dsh'
  /** Display name of the project (scanner id or folder name). */
  project: string
  projectPath: string
  /** Writes in its own lane and reaches main through an MR (the project's delivery is `mr`). */
  worktree: boolean
  /** Only looks; told so (dsh has no plan mode to hold it to that). */
  readonly?: boolean
  /** The lane, once made; removed again once it is cleaned. */
  branch?: string
  worktreePath?: string
  /** The person asked for the MR. */
  mrOpened?: boolean
  /** The Worker's dsh Session, once created. */
  sessionId?: string
  model?: ModelRoute
  state: TicketState
  /** What the Worker is waiting on, while `asking`. */
  pending?: { kind: 'question' | 'approval'; summary: string; at: number }
  /** The earlier ticket this one carries on, as the Router said at dispatch. */
  follows?: number
  /** The latest message the Worker or the plugin sent the person, shown as 「最近消息」. */
  lastReport?: string
  createdAt: number
  updatedAt: number
  endedAt?: number
}

export type Actor = 'you' | 'router' | 'worker' | 'superagent'

export type TicketEvent = {
  id: number
  ticketId: number
  kind: EventKind
  body: string
  actor: Actor
  at: number
}

export type Project = { id: string; path: string; root: string }

/** `merged`: an MR ticket's change is in main; only after the person asked for the MR. */
export type Outcome = 'ready' | 'blocked' | 'failed' | 'dropped' | 'merged'

/** One event as the Router reads it: header, a capped summary, and what came just before. */
export type DigestItem = {
  ticketId: number
  project: string
  title: string
  kind: EventKind
  summary: string
  isCut: boolean
  priorReport?: string
}
