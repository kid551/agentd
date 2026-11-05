import { NEEDS_ME, STATE_WORDS, phaseWord, type TicketState } from '../core/state.js'
import type { StateView, TicketView } from '../host/http.js'

// Pure view logic for the browser half, so tests read it without a DOM.

export type Group = { key: 'needs' | 'active' | 'ended'; title: string; tickets: TicketView[] }

export function groups(tickets: TicketView[]): Group[] {
  const needs = tickets.filter(t => NEEDS_ME.includes(t.state))
  const active = tickets.filter(t => t.state === 'working' || t.state === 'queued')
  const ended = tickets.filter(t => t.state === 'done' || t.state === 'stopped')
  return [
    { key: 'needs' as const, title: '待我处理', tickets: needs },
    { key: 'active' as const, title: '进行中', tickets: active },
    { key: 'ended' as const, title: '已结束', tickets: ended.reverse() },
  ].filter(g => g.tickets.length > 0)
}

/** Theme tone of a state: a `--dsw-alias-state-*` family. */
export function tone(state: TicketState): 'warn' | 'success' | 'error' | 'business' | 'idle' {
  switch (state) {
    case 'asking':
    case 'interrupted':
      return 'warn'
    case 'ready':
    case 'done':
      return 'success'
    case 'blocked':
    case 'failed':
      return 'error'
    case 'working':
      return 'business'
    default:
      return 'idle'
  }
}

export const stateWord = (state: TicketState): string => STATE_WORDS[state]

export type Action = 'chat' | 'open_mr' | 'stop' | 'retry' | 'resume' | 'close' | 'discard'

/** Buttons a card offers, in order. An MR ticket with a lane is given up, never just closed. */
export function actionsOf(t: TicketView): Action[] {
  const out: Action[] = []
  if (t.sessionId !== undefined) out.push('chat')
  if (t.state === 'ready' && t.worktreePath !== undefined && t.mrOpened !== true)
    out.push('open_mr')
  if (t.state === 'working' || t.state === 'asking' || t.state === 'queued') out.push('stop')
  if (t.state === 'blocked' || t.state === 'failed') out.push('retry')
  if (t.state === 'stopped' || t.state === 'interrupted') out.push('resume')
  if (t.worktreePath !== undefined) out.push('discard')
  else if (t.state !== 'done' && t.state !== 'stopped') out.push('close')
  return out
}

export const ACTION_WORDS = {
  chat: '单聊',
  open_mr: '开 MR',
  stop: '停',
  retry: '重试',
  resume: '恢复',
  close: '收',
  discard: '放弃',
} as const

/** How long ago, as a person says it; seconds under a minute. */
export function ago(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))} 秒前`
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`
}

/** The Router's counts, shown in a Worker's band too so a chat never hides them. */
type Counts = { needs: number; active: number }

export type BandView =
  | ({ kind: 'router' } & Counts)
  | ({ kind: 'worker'; ticket: TicketView } & Counts)
  | { kind: 'none' }

/** What the band above the composer says in a given Session. */
export function bandOf(state: StateView | undefined, sessionId: string | undefined): BandView {
  if (state === undefined || sessionId === undefined) return { kind: 'none' }
  const counts: Counts = {
    needs: state.tickets.filter(t => t.needsMe).length,
    active: state.tickets.filter(t => t.state === 'working' || t.state === 'queued').length,
  }
  if (sessionId === state.routerSessionId) return { kind: 'router', ...counts }
  const ticket = state.tickets.find(t => t.sessionId === sessionId)
  return ticket === undefined ? { kind: 'none' } : { kind: 'worker', ticket, ...counts }
}

/** The counts that are not zero, as the Router band has always said them. */
const countParts = (c: Counts): string[] => [
  ...(c.needs > 0 ? [`待处理 ${c.needs}`] : []),
  ...(c.active > 0 ? [`进行中 ${c.active}`] : []),
]

export function bandText(view: BandView): string {
  if (view.kind === 'router') return ['对 Router 说', ...countParts(view)].join(' · ')
  if (view.kind === 'worker') {
    const t = view.ticket
    const counts = countParts(view)
    const router = counts.length > 0 ? `· Router ${counts.join(' · ')}` : ''
    return `单聊 #${t.id} · ${t.project} · ${t.title}（${phaseWord(t)}）${router}`
  }
  return ''
}

/** The next ticket waiting for the person after the given one, wrapping around. */
export function nextNeeding(
  tickets: TicketView[],
  afterId: number | undefined,
): TicketView | undefined {
  const needs = tickets
    .filter(t => t.needsMe && t.sessionId !== undefined)
    .sort((a, b) => a.id - b.id)
  if (needs.length === 0) return undefined
  return needs.find(t => afterId === undefined || t.id > afterId) ?? needs[0]
}
