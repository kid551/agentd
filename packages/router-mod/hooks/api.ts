import type { HttpInit, HttpResponse } from 'claude-code'

import type { EventLite, TicketLite } from '../types'

// The daemon's HTTP API as the mod reads it. A mod imports nothing from npm,
// so these shapes mirror packages/agentd/src/types.ts by hand.

export type Ticket = {
  id: number
  title: string
  project: string
  cwd: string
  state: TicketLite['state']
  needsMe: boolean
  workerName: string
  workerSessionId: string | null
  workerBgId: string | null
  lastReport: string | null
  /** Absent from daemons older than answers under the latest message. */
  lastAnswer?: string | null
  /** Absent from daemons older than parallel tickets. */
  readonly?: boolean
  worktree?: boolean
  branch?: string | null
  mrOpened?: boolean
  openQuestion: {
    id: number
    kind?: 'ask' | 'permission'
    question: string
    options: string[] | null
  } | null
  updatedAt: number
}

export type FeedEvent = {
  id: number
  ticketId: number
  kind: string
  summary: string
  isCut: boolean
  /** Absent from daemons older than locality inline. */
  priorReport?: string | null
  ticket: { id: number; title: string; project: string }
}

export type Reply<T> =
  { ok: true; status: number; data: T } | { ok: false; status: number; reason: string }

export const lite = (t: Ticket): TicketLite => ({
  id: t.id,
  title: t.title,
  project: t.project,
  state: t.state,
  needsMe: t.needsMe,
  cwd: t.cwd,
  workerName: t.workerName,
  workerSessionId: t.workerSessionId,
  workerBgId: t.workerBgId,
  question: t.openQuestion?.question ?? null,
  options: t.openQuestion?.options ?? null,
  isPermission: t.openQuestion?.kind === 'permission',
  readonly: t.readonly === true,
  worktree: t.worktree === true,
  branch: t.branch ?? null,
  mrOpened: t.mrOpened === true,
  lastReport: t.lastReport,
  lastAnswer: t.lastAnswer ?? null,
  updatedAt: t.updatedAt,
})

export const liteEvent = (e: FeedEvent): EventLite => ({
  id: e.id,
  ticketId: e.ticketId,
  kind: e.kind,
  summary: e.summary,
  isCut: e.isCut,
  priorReport: e.priorReport ?? null,
  title: e.ticket.title,
  project: e.ticket.project,
})

/** `$.http.fetch`, handed in as a closure: a mod never passes `$` itself around. */
export type Fetch = (url: string, init?: HttpInit) => Promise<HttpResponse>

export class Api {
  constructor(
    private readonly fetch: Fetch,
    readonly base: string,
  ) {}

  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply<T>> {
    try {
      const res = await this.fetch(`${this.base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const data = JSON.parse(res.text || 'null') as T & { reason?: string }
      if (res.ok) return { ok: true, status: res.status, data }
      return { ok: false, status: res.status, reason: data?.reason ?? `HTTP ${res.status}` }
    } catch (error) {
      return { ok: false, status: 0, reason: `agentd 不在线：${String(error)}` }
    }
  }

  get<T>(path: string) {
    return this.call<T>('GET', path)
  }

  post<T>(path: string, body: unknown = {}) {
    return this.call<T>('POST', path, body)
  }
}
