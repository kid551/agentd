// agentd-router's session state: what the Pane and the band draw from.

export type TicketLite = {
  id: number
  title: string
  project: string
  state: 'queued' | 'working' | 'asking' | 'ready' | 'blocked' | 'failed' | 'done' | 'stopped'
  needsMe: boolean
  cwd: string
  workerName: string
  workerSessionId: string | null
  workerBgId: string | null
  question: string | null
  options: string[] | null
  /** The open question asks the person to approve a refused tool call. */
  isPermission?: boolean
  /** Looks, never writes (absent from older daemons). */
  readonly?: boolean
  /** Writes in its own worktree and reaches main through an MR. */
  worktree?: boolean
  /** The lane's branch while it exists. */
  branch?: string | null
  /** The person asked for the MR. */
  mrOpened?: boolean
  lastReport: string | null
  /** The person's answer to `lastReport`, when that is a question they answered. */
  lastAnswer?: string | null
  updatedAt: number
}

export type EventLite = {
  id: number
  ticketId: number
  kind: string
  summary: string
  isCut: boolean
  /** The ticket's last progress report before a hand-back, for context. */
  priorReport: string | null
  title: string
  project: string
}

/** A working Worker's last lines, and when the newest was written (ms). */
export type ActivityLite = { ticketId: number; lines: string[]; at: number | null }

/** Working Workers' last lines; `tick` moves every 10 s so their age keeps counting. */
export type Activity = { items: ActivityLite[]; tick: number }

export type Daemon = 'up' | 'down' | 'starting'

/** The ticket the person chats with; `isAuto` when its question opened the chat. */
export type Chat = { ticket: number; isAuto: boolean }

/** Cards unfolded in the Pane: ticket id → the message it was unfolded on. */
export type Unfolded = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    'agentd-router': {
      tickets: Shaped<TicketLite[]>
      chat: Shaped<Chat | null>
      queue: Shaped<EventLite[]>
      activity: Shaped<Activity>
      daemon: Daemon
      confirmStop: number | null
      confirmDiscard: number | null
      isInjectBlocked: boolean
      endedPage: number
      unfolded: Shaped<Unfolded>
      isWorkingBrief: boolean
    }
  }
}
