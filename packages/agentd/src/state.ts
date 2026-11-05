import type { EventKind, TicketState } from './types.js'

/**
 * The inputs that move a ticket. Every state change in the daemon goes through
 * `transition`, so this table is the whole lifecycle.
 */
export type Input =
  | 'spawn_ok'
  | 'spawn_fail'
  | 'report'
  | 'ask'
  | 'answer'
  | 'message'
  | 'done_ready'
  | 'done_blocked'
  | 'done_failed'
  | 'done_dropped'
  | 'stalled'
  | 'exited'
  | 'close'
  | 'stop'
  | 'retry'
  | 'resume'
  | 'open_mr'
  | 'done_merged'

type Table = Partial<Record<Input, Partial<Record<TicketState, TicketState>>>>

const LIVE: TicketState[] = ['working', 'asking', 'ready', 'blocked', 'failed']
const from = (states: TicketState[], to: TicketState): Partial<Record<TicketState, TicketState>> =>
  Object.fromEntries(states.map(s => [s, to]))

const TABLE: Table = {
  spawn_ok: { queued: 'working' },
  spawn_fail: { queued: 'failed' },
  // A report after a handoff means the Worker picked the work up again itself.
  report: { ...from(['working', 'ready', 'blocked', 'failed'], 'working'), asking: 'asking' },
  ask: from(['working', 'ready', 'blocked', 'failed'], 'asking'),
  answer: { asking: 'working' },
  // A message to a Worker that stopped wakes it; an open question stays open
  // (answer it instead). `done` reopens: the person asked for more.
  message: {
    ...from(['working', 'ready', 'blocked', 'failed', 'done'], 'working'),
    asking: 'asking',
  },
  done_ready: from(['working', 'asking'], 'ready'),
  done_blocked: from(['working', 'asking'], 'blocked'),
  done_failed: from(['working', 'asking'], 'failed'),
  done_dropped: from(['working', 'asking'], 'done'),
  stalled: { working: 'blocked' },
  exited: from(['working', 'asking'], 'failed'),
  close: from(['queued', ...LIVE], 'done'),
  stop: from(['queued', ...LIVE], 'stopped'),
  // Only for a ticket whose Worker never started; a live Worker gets a message.
  retry: { failed: 'queued', blocked: 'queued' },
  // The person stopped it midway and wants it to go on: its conversation is relaunched.
  resume: { stopped: 'working' },
  // MR tickets: the person approved what the Worker handed back, so it goes on
  // to open the MR. No state of its own: the ticket's `mrOpened` says which
  // phase a working Worker is in, and every input above holds for both.
  open_mr: { ready: 'working' },
  done_merged: from(['working', 'asking'], 'done'),
}

export type Transition = { ok: true; to: TicketState } | { ok: false; reason: string }

export function transition(state: TicketState, input: Input): Transition {
  const to = TABLE[input]?.[state]
  if (to === undefined) return { ok: false, reason: `ticket 处于 ${state}，不能 ${input}` }
  return { ok: true, to }
}

/** The event recorded for an input. */
export const EVENT_OF: Record<Input, EventKind> = {
  spawn_ok: 'spawned',
  spawn_fail: 'spawn_failed',
  report: 'progress',
  ask: 'ask',
  answer: 'answer',
  message: 'message',
  done_ready: 'ready',
  done_blocked: 'blocked',
  done_failed: 'failed',
  done_dropped: 'dropped',
  stalled: 'stalled',
  exited: 'exited',
  close: 'closed',
  stop: 'stopped',
  retry: 'retried',
  resume: 'resumed',
  open_mr: 'mr_requested',
  done_merged: 'merged',
}
