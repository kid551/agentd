import {
  ENDED,
  EVENT_OF,
  HANDBACK_KINDS,
  NOTIFY_KINDS,
  transition,
  type EventKind,
  type Input,
} from '../core/state.js'
import { cut } from '../core/text.js'
import type { Actor, DigestItem, Ticket, TicketEvent } from '../core/types.js'
import { INITIAL_META, META_KEY, type Meta, type Tables } from './tables.js'

export type Applied =
  { ok: true; ticket: Ticket; event: TicketEvent } | { ok: false; reason: string }

/** Events kept per ended ticket; older ones are dropped when it ends. */
const KEEP_ENDED_EVENTS = 50

/**
 * Event kinds whose text becomes the ticket's latest message (`lastReport`):
 * what the Worker or the plugin last said to the person, a pending question or
 * approval included. Not the person's own words, and not a launch failure:
 * its reason would outlive a retry that worked.
 */
const LAST_MESSAGE_KINDS: readonly EventKind[] = [
  'progress',
  'ask',
  'ready',
  'blocked',
  'failed',
  'dropped',
  'merged',
  'stalled',
  'interrupted',
]

/**
 * The single writer of the plugin's records. Every write goes through one
 * promise chain, so a read-check-write (the state transition) never races
 * another one, even across async callers.
 */
export class Board {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly tables: Tables,
    private readonly now: () => number = Date.now,
  ) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work)
    this.chain = next.catch(() => undefined)
    return next
  }

  meta(): Meta {
    return this.tables.meta.get(META_KEY) ?? INITIAL_META
  }

  private async putMeta(patch: Partial<Meta>): Promise<Meta> {
    const next = { ...this.meta(), ...patch }
    await this.tables.meta.put(META_KEY, next)
    return next
  }

  setMeta(patch: Partial<Meta>): Promise<Meta> {
    return this.serial(() => this.putMeta(patch))
  }

  get(id: number): Ticket | undefined {
    return this.tables.tickets.get(String(id))
  }

  bySession(sessionId: string): Ticket | undefined {
    for (const [, t] of this.tables.tickets.entries()) if (t.sessionId === sessionId) return t
    return undefined
  }

  list(): Ticket[] {
    return [...this.tables.tickets.entries()].map(([, t]) => t).sort((a, b) => a.id - b.id)
  }

  eventsOf(id: number): TicketEvent[] {
    return [...this.tables.events.entries()]
      .map(([, e]) => e)
      .filter(e => e.ticketId === id)
      .sort((a, b) => a.id - b.id)
  }

  private async record(ticketId: number, kind: TicketEvent['kind'], body: string, actor: Actor) {
    const meta = this.meta()
    const event: TicketEvent = { id: meta.nextEventId, ticketId, kind, body, actor, at: this.now() }
    await this.tables.events.put(String(event.id), event)
    await this.putMeta({ nextEventId: meta.nextEventId + 1 })
    return event
  }

  create(input: Omit<Ticket, 'id' | 'state' | 'createdAt' | 'updatedAt'>): Promise<Ticket> {
    return this.serial(async () => {
      const meta = this.meta()
      const at = this.now()
      const ticket: Ticket = {
        ...input,
        id: meta.nextTicketId,
        state: 'queued',
        createdAt: at,
        updatedAt: at,
      }
      await this.tables.tickets.put(String(ticket.id), ticket)
      await this.putMeta({ nextTicketId: meta.nextTicketId + 1 })
      await this.record(ticket.id, 'dispatched', input.task, 'router')
      return ticket
    })
  }

  /** Field changes that are not state changes (the Worker's Session id, its model, its lane). */
  patch(
    id: number,
    fields: Partial<
      Pick<Ticket, 'sessionId' | 'model' | 'pending' | 'worktreePath' | 'branch' | 'mrOpened'>
    >,
  ): Promise<Ticket | undefined> {
    return this.serial(async () => {
      const t = this.get(id)
      if (t === undefined) return undefined
      const next = { ...t, ...fields, updatedAt: this.now() }
      await this.tables.tickets.put(String(id), next)
      return next
    })
  }

  /**
   * Takes back an MR request the Worker never received, as if never made: the
   * ticket is ready again. Only while the request is still its latest event.
   */
  unopenMr(id: number): Promise<Ticket | undefined> {
    return this.serial(async () => {
      const t = this.get(id)
      const last = this.eventsOf(id).at(-1)
      if (t?.state !== 'working' || t.mrOpened !== true || last?.kind !== 'mr_requested')
        return undefined
      await this.tables.events.delete(String(last.id))
      const next: Ticket = { ...t, state: 'ready', updatedAt: this.now() }
      delete next.mrOpened
      await this.tables.tickets.put(String(id), next)
      return next
    })
  }

  /** Records an event that moves no state (a lane cleaned or kept). */
  note(id: number, kind: TicketEvent['kind'], body: string, actor: Actor): Promise<TicketEvent> {
    return this.serial(() => this.record(id, kind, body, actor))
  }

  /** The one way a ticket changes state: check the table, write the state, record the event. */
  apply(
    id: number,
    input: Input,
    body: string,
    actor: Actor,
    fields: Partial<Pick<Ticket, 'sessionId' | 'pending'>> = {},
  ): Promise<Applied> {
    return this.serial(async () => {
      const t = this.get(id)
      if (t === undefined) return { ok: false, reason: `没有奏折 #${id}` }
      const moved = transition(t.state, input)
      if (!moved.ok) return moved
      const kind = EVENT_OF[input]
      const at = this.now()
      const next: Ticket = { ...t, ...fields, state: moved.to, updatedAt: at }
      if (moved.to !== 'asking') delete next.pending
      if (LAST_MESSAGE_KINDS.includes(kind) && body.trim() !== '') next.lastReport = body
      if (ENDED.includes(moved.to)) next.endedAt = at
      else delete next.endedAt
      await this.tables.tickets.put(String(id), next)
      const event = await this.record(id, kind, body, actor)
      if (ENDED.includes(moved.to)) await this.trim(id)
      return { ok: true, ticket: next, event }
    })
  }

  private async trim(id: number): Promise<void> {
    const events = this.eventsOf(id)
    for (const e of events.slice(0, Math.max(0, events.length - KEEP_ENDED_EVENTS))) {
      await this.tables.events.delete(String(e.id))
    }
  }

  /** Events the Router must hear about and has not yet, as digest items. */
  undelivered(
    inlineChars: number,
    told: ReadonlySet<number> = new Set(),
  ): { items: DigestItem[]; lastId: number } {
    const seen = this.meta().routerSeenEventId
    const all = [...this.tables.events.entries()].map(([, e]) => e).sort((a, b) => a.id - b.id)
    const fresh = all.filter(e => e.id > seen)
    const items: DigestItem[] = []
    for (const e of fresh) {
      if (!NOTIFY_KINDS.includes(e.kind) || told.has(e.id)) continue
      const t = this.get(e.ticketId)
      if (t === undefined) continue
      const body = cut(e.body, inlineChars)
      const item: DigestItem = {
        ticketId: t.id,
        project: t.project,
        title: t.title,
        kind: e.kind,
        summary: body.text,
        isCut: body.isCut,
      }
      if (HANDBACK_KINDS.includes(e.kind)) {
        // Locality Inline: the last progress before this event, not the ticket's
        // lastReport, which later handbacks overwrite.
        const prior = all
          .filter(p => p.ticketId === t.id && p.id < e.id && p.kind === 'progress')
          .at(-1)
        if (prior !== undefined) item.priorReport = cut(prior.body, inlineChars).text
      }
      items.push(item)
    }
    return { items, lastId: fresh.at(-1)?.id ?? seen }
  }

  markSeen(lastId: number): Promise<Meta> {
    return this.serial(() =>
      this.putMeta({ routerSeenEventId: Math.max(lastId, this.meta().routerSeenEventId) }),
    )
  }
}
