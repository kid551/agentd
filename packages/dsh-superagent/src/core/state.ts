// The ticket lifecycle. Every state change in the host plugin goes through
// `transition`, so this table is the whole lifecycle. Ported from agentd's
// state.ts; the differences are the dsh-native question/approval mirror (no
// question table: dsh owns the question) and `interrupted` (the app or the
// plugin went away while a Worker was running).

export const TICKET_STATES = [
  'queued',
  'working',
  'asking',
  'ready',
  'blocked',
  'failed',
  'interrupted',
  'done',
  'stopped',
] as const
export type TicketState = (typeof TICKET_STATES)[number]

/** States that wait for the person: the board's「待我处理」group. */
export const NEEDS_ME: readonly TicketState[] = [
  'asking',
  'ready',
  'blocked',
  'failed',
  'interrupted',
]
/** States whose Worker is expected to be running or about to run a turn. */
export const ACTIVE: readonly TicketState[] = ['working', 'asking']
/**
 * States whose Worker may still hold uncommitted work in the project folder:
 * one such ticket per project, unless it writes in its own lane (worktree).
 */
export const OCCUPYING: readonly TicketState[] = [
  'working',
  'asking',
  'ready',
  'blocked',
  'failed',
  'interrupted',
]
/** States no automatic input changes; `done` can still be reopened by a message. */
export const ENDED: readonly TicketState[] = ['done', 'stopped']

export type Input =
  | 'spawn_ok'
  | 'spawn_fail'
  | 'report'
  | 'ask'
  | 'answered'
  | 'message'
  | 'user_said'
  | 'done_ready'
  | 'done_blocked'
  | 'done_failed'
  | 'done_dropped'
  | 'stalled'
  | 'interrupted'
  | 'close'
  | 'stop'
  | 'retry'
  | 'resume'
  | 'open_mr'
  | 'done_merged'

export type EventKind =
  | 'dispatched'
  | 'spawned'
  | 'spawn_failed'
  | 'progress'
  | 'ask'
  | 'answered'
  | 'message'
  | 'user_said'
  | 'ready'
  | 'blocked'
  | 'failed'
  | 'dropped'
  | 'stalled'
  | 'interrupted'
  | 'closed'
  | 'stopped'
  | 'retried'
  | 'resumed'
  /** The person approved an MR ticket's change: the Worker opens the MR. */
  | 'mr_requested'
  | 'merged'
  /** The ticket's lane (worktree and branch) was removed. */
  | 'cleaned'
  /** The lane could not be removed safely, and was left for the person. */
  | 'kept'

type Table = Partial<Record<Input, Partial<Record<TicketState, TicketState>>>>

const HANDED_BACK: TicketState[] = ['ready', 'blocked', 'failed']
const LIVE: TicketState[] = ['working', 'asking', ...HANDED_BACK, 'interrupted']
const from = (states: TicketState[], to: TicketState): Partial<Record<TicketState, TicketState>> =>
  Object.fromEntries(states.map(s => [s, to]))

const TABLE: Table = {
  spawn_ok: { queued: 'working' },
  spawn_fail: { queued: 'failed' },
  // A report after a handoff means the Worker picked the work up again itself.
  report: { ...from(['working', ...HANDED_BACK], 'working'), asking: 'asking' },
  // dsh shows the question or approval in the Worker's own Session.
  ask: from(['working', ...HANDED_BACK], 'asking'),
  answered: { asking: 'working' },
  // A message wakes a Worker that handed back; an open question stays open.
  message: { ...from(['working', ...HANDED_BACK, 'done'], 'working'), asking: 'asking' },
  // The person typed in the Worker's Session: same as a message, and it is
  // also how a question gets answered (the answer itself is observed apart).
  user_said: { ...from(['working', ...HANDED_BACK, 'done'], 'working'), asking: 'asking' },
  done_ready: from(['working', 'asking'], 'ready'),
  done_blocked: from(['working', 'asking'], 'blocked'),
  done_failed: from(['working', 'asking'], 'failed'),
  done_dropped: from(['working', 'asking'], 'done'),
  stalled: { working: 'blocked' },
  interrupted: from(['working', 'asking'], 'interrupted'),
  close: from(['queued', ...LIVE], 'done'),
  stop: from(['queued', ...LIVE], 'stopped'),
  // A Worker that never started goes back to the queue; one that handed back
  // is woken in its own Session (the service decides which).
  retry: { failed: 'queued', blocked: 'queued' },
  resume: { stopped: 'working', interrupted: 'working' },
  // MR tickets: the person approved what the Worker handed back, so it goes on
  // to open the MR. No state of its own: `mrOpened` says which phase it is in.
  open_mr: { ready: 'working' },
  done_merged: from(['working', 'asking'], 'done'),
}

export type Transition = { ok: true; to: TicketState } | { ok: false; reason: string }

export function transition(state: TicketState, input: Input): Transition {
  const to = TABLE[input]?.[state]
  if (to === undefined)
    return { ok: false, reason: `奏折处于「${STATE_WORDS[state]}」，不能 ${input}` }
  return { ok: true, to }
}

/** The event recorded for an input. */
export const EVENT_OF: Record<Input, EventKind> = {
  spawn_ok: 'spawned',
  spawn_fail: 'spawn_failed',
  report: 'progress',
  ask: 'ask',
  answered: 'answered',
  message: 'message',
  user_said: 'user_said',
  done_ready: 'ready',
  done_blocked: 'blocked',
  done_failed: 'failed',
  done_dropped: 'dropped',
  stalled: 'stalled',
  interrupted: 'interrupted',
  close: 'closed',
  stop: 'stopped',
  retry: 'retried',
  resume: 'resumed',
  open_mr: 'mr_requested',
  done_merged: 'merged',
}

/** Event kinds handed to the Router model: someone must act. */
export const NOTIFY_KINDS: readonly EventKind[] = [
  'ask',
  'ready',
  'blocked',
  'failed',
  'dropped',
  'stalled',
  'interrupted',
  'spawn_failed',
  'merged',
  'kept',
]

/** Kinds that hand work back: they carry the last progress before them (locality Inline). */
export const HANDBACK_KINDS: readonly EventKind[] = [
  'ask',
  'blocked',
  'failed',
  'stalled',
  'interrupted',
]

export const STATE_WORDS: Record<TicketState, string> = {
  queued: '排队',
  working: '在干',
  asking: '等你',
  ready: '就绪',
  blocked: '受阻',
  failed: '失败',
  interrupted: '中断',
  done: '已结束',
  stopped: '已停',
}

/** The state as the person reads it: an MR ticket's phase has words of its own. */
export const phaseWord = (t: {
  state: TicketState
  worktree?: boolean
  mrOpened?: boolean
}): string => {
  if (t.worktree === true && t.state === 'ready' && t.mrOpened !== true) return '待审'
  if (t.worktree === true && t.mrOpened === true && (t.state === 'working' || t.state === 'asking'))
    return t.state === 'asking' ? 'MR 中 · 等你' : 'MR 中'
  return STATE_WORDS[t.state]
}
