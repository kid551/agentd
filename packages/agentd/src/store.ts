import type { DatabaseSync as Db } from 'node:sqlite'

import { APPROVE, isApproval, REJECT } from './permission.js'
import { EVENT_OF, transition, type Input } from './state.js'
import {
  ENDED,
  NEEDS_ME,
  type Actor,
  type EventKind,
  type EventView,
  type Project,
  type Question,
  type QuestionKind,
  type TicketState,
  type TicketView,
} from './types.js'

// Loaded at first use rather than imported: a static import is hoisted above
// quiet.ts in the bundle, and node:sqlite warns as it loads.
const sqlite = (): typeof import('node:sqlite') =>
  process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')

const MIGRATIONS: string[] = [
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     path TEXT NOT NULL UNIQUE,
     root TEXT NOT NULL,
     last_seen_at INTEGER NOT NULL
   );
   CREATE TABLE tickets (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL,
     project_id TEXT NOT NULL,
     cwd TEXT NOT NULL,
     prompt TEXT NOT NULL,
     state TEXT NOT NULL,
     worktree INTEGER NOT NULL DEFAULT 0,
     model TEXT NOT NULL,
     source TEXT NOT NULL DEFAULT 'router',
     worker_name TEXT NOT NULL DEFAULT '',
     worker_session_id TEXT,
     worker_bg_id TEXT,
     last_report TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     ended_at INTEGER
   );
   CREATE INDEX tickets_state ON tickets (state);
   CREATE INDEX tickets_project_state ON tickets (project_id, state);
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ticket_id INTEGER NOT NULL REFERENCES tickets (id),
     ts INTEGER NOT NULL,
     kind TEXT NOT NULL,
     actor TEXT NOT NULL,
     body TEXT NOT NULL
   );
   CREATE INDEX events_ticket ON events (ticket_id, id);
   CREATE TABLE questions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ticket_id INTEGER NOT NULL REFERENCES tickets (id),
     asked_at INTEGER NOT NULL,
     question TEXT NOT NULL,
     options TEXT,
     answered_at INTEGER,
     answer TEXT,
     last_polled_at INTEGER
   );
   CREATE INDEX questions_open ON questions (ticket_id) WHERE answered_at IS NULL;`,
  // `recent` lists tickets ended in the last day.
  `CREATE INDEX tickets_ended ON tickets (ended_at) WHERE ended_at IS NOT NULL;`,
  // Permission questions: `grant_key` names the refused tool call an approval lets through.
  `ALTER TABLE questions ADD COLUMN kind TEXT NOT NULL DEFAULT 'ask';
   ALTER TABLE questions ADD COLUMN grant_key TEXT;`,
  // Parallel tickets: readonly ones, and MR ones writing in their own lane.
  `ALTER TABLE tickets ADD COLUMN readonly INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE tickets ADD COLUMN branch TEXT;
   ALTER TABLE tickets ADD COLUMN worktree_path TEXT;
   ALTER TABLE tickets ADD COLUMN repo_path TEXT;
   ALTER TABLE tickets ADD COLUMN mr_opened_at INTEGER;`,
  // The person's answer to the question that is the ticket's latest message.
  `ALTER TABLE tickets ADD COLUMN last_answer TEXT;`,
  // The earlier ticket this one carries on (chain of recall: one hop back, and its followers forward).
  // No REFERENCES: dispatch checks it, tickets are never deleted, and a column in
  // a foreign key could never be dropped again.
  `ALTER TABLE tickets ADD COLUMN follows_id INTEGER;
   CREATE INDEX tickets_follows ON tickets (follows_id) WHERE follows_id IS NOT NULL;`,
]

type TicketRow = {
  id: number
  title: string
  project_id: string
  cwd: string
  prompt: string
  state: TicketState
  worktree: number
  readonly: number
  branch: string | null
  worktree_path: string | null
  repo_path: string | null
  mr_opened_at: number | null
  model: string
  worker_name: string
  worker_session_id: string | null
  worker_bg_id: string | null
  last_report: string | null
  last_answer: string | null
  follows_id: number | null
  created_at: number
  updated_at: number
  ended_at: number | null
}

type EventRow = {
  id: number
  ticket_id: number
  ts: number
  kind: EventKind
  actor: Actor
  body: string
  title: string
  project_id: string
  /** Only in the feed: the body of the ticket's last progress event before this one. */
  prior_body?: string | null
}

/**
 * Kinds whose feed entry carries the progress report before it. Not `ready`:
 * its own text is the result. Not `dropped` / `spawn_failed`: no Worker ran.
 */
const PRIOR_REPORT_KINDS: readonly EventKind[] = ['ask', 'blocked', 'failed', 'stalled', 'exited']

/**
 * Inputs whose text becomes the ticket's latest message (`last_report`): what
 * the Worker or agentd last said to the person, a question or permission
 * request included. Not the person's own words (answers, messages), and not a
 * launch failure: its reason would outlive a retry that worked.
 */
const LAST_MESSAGE_INPUTS: readonly Input[] = [
  'report',
  'ask',
  'done_ready',
  'done_blocked',
  'done_failed',
  'done_dropped',
  'done_merged',
  'stalled',
  'exited',
]

/** An answer shown under the latest message is cut to this; the event keeps it whole. */
const ANSWER_CHARS = 200

/** What the person's decision to open the MR shows as, under the hand-back it answers. */
const OPEN_MR_ANSWER = '开 MR'

/** An answer that is only an option's letter or number: 「B」「b。」「选择 B」「2」. */
const PICK = /^(?:选择?\s*)?([A-Za-z]|\d{1,2})\s*[。.．!！，,]?$/

/**
 * The option an answer picks by its place (A or 1 for the first, as the
 * `/ticket` card labels them), shown with its letter unless it carries a label
 * of its own. Null when the answer says more than a pick, names no option, or
 * is an option's own words.
 */
export function pickedOption(text: string, options: readonly string[]): string | null {
  const said = text.trim()
  if (options.some(o => o.trim() === said)) return null
  const label = PICK.exec(said)?.[1]?.toUpperCase()
  if (label === undefined) return null
  const i = /\d/.test(label) ? Number(label) - 1 : label.charCodeAt(0) - 65
  const option = options[i]?.trim()
  if (!option) return null
  const letter = String.fromCharCode(65 + i)
  return new RegExp(`^(?:${letter}|${i + 1})(?![A-Za-z0-9])`, 'i').test(option)
    ? option
    : `${letter}. ${option}`
}

type QuestionRow = {
  id: number
  ticket_id: number
  kind: QuestionKind
  asked_at: number
  question: string
  options: string | null
  answered_at: number | null
  answer: string | null
  last_polled_at: number | null
  grant_key: string | null
}

/** The open question's columns a ticket row carries from its LEFT JOIN; all null without one. */
type OpenQuestionCols = {
  q_id: number | null
  q_kind: QuestionKind | null
  q_question: string | null
  q_options: string | null
  q_asked_at: number | null
}

export type EventBody = { text?: string; [key: string]: unknown }

/** An unanswered question as the daemon sees it: with what its approval would let through. */
export type OpenQuestion = Question & { grantKey: string | null }

export type ApplyResult =
  | {
      ok: true
      ticket: TicketView
      eventId: number
      from: TicketState
      /** The open question this input withdrew, when it left `asking` unanswered. */
      withdrawnQuestionId?: number
    }
  | { ok: false; reason: string; ticket: TicketView | null }

/** Cuts text to `limit` characters at a boundary a reader can follow. */
export function cut(text: string, limit: number): { text: string; isCut: boolean } {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return { text: flat, isCut: false }
  return { text: `${flat.slice(0, limit - 1)}…`, isCut: true }
}

export class Store {
  readonly db: Db
  private readonly now: () => number
  private readonly inlineChars: number

  constructor(file: string, options: { now?: () => number; inlineChars?: number } = {}) {
    this.db = new (sqlite().DatabaseSync)(file)
    this.now = options.now ?? Date.now
    this.inlineChars = options.inlineChars ?? 300
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v] as string)
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
      })
    }
  }

  /** Runs `fn` in one immediate transaction; nested calls join the outer one. */
  private depth = 0
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth++
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.depth--
    }
  }

  // ---- projects -----------------------------------------------------------

  replaceProjects(projects: Project[]): void {
    const at = this.now()
    this.tx(() => {
      const upsert = this.db.prepare(
        `INSERT INTO projects (id, path, root, last_seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET id = excluded.id, root = excluded.root,
           last_seen_at = excluded.last_seen_at`,
      )
      // Ids can move between paths when a same-named repository appears, so
      // clear the old rows that the new scan no longer has first.
      const paths = new Set(projects.map(p => p.path))
      const old = this.db.prepare('SELECT path FROM projects').all() as { path: string }[]
      const remove = this.db.prepare('DELETE FROM projects WHERE path = ?')
      for (const row of old) if (!paths.has(row.path)) remove.run(row.path)
      this.db.exec("UPDATE projects SET id = '~' || id")
      for (const p of projects) upsert.run(p.id, p.path, p.root, at)
    })
  }

  listProjects(): Project[] {
    return this.db.prepare('SELECT id, path, root FROM projects ORDER BY id').all() as Project[]
  }

  // ---- tickets ------------------------------------------------------------

  createTicket(input: {
    title: string
    project: Project
    prompt: string
    model: string
    worktree: boolean
    readonly?: boolean
    /** Must name an existing ticket; the caller checks. */
    followsId?: number
  }): TicketView {
    return this.tx(() => {
      const at = this.now()
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO tickets (title, project_id, cwd, prompt, state, worktree, readonly, model, follows_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.title,
          input.project.id,
          input.project.path,
          input.prompt,
          input.worktree ? 1 : 0,
          input.readonly ? 1 : 0,
          input.model,
          input.followsId ?? null,
          at,
          at,
        )
      const id = Number(lastInsertRowid)
      this.db.prepare('UPDATE tickets SET worker_name = ? WHERE id = ?').run(`agentd-w-${id}`, id)
      this.addEvent(id, 'dispatched', 'router', { text: input.prompt })
      return this.ticket(id) as TicketView
    })
  }

  ticket(id: number): TicketView | null {
    return this.rows('WHERE t.id = ?', [id])[0] ?? null
  }

  ticketPrompt(id: number): string | null {
    const row = this.db.prepare('SELECT prompt FROM tickets WHERE id = ?').get(id) as
      { prompt: string } | undefined
    return row?.prompt ?? null
  }

  /** `open`: not ended; `needs_me`: waiting for the person; `recent`: open or ended in 24 h. */
  listTickets(filter: 'open' | 'needs_me' | 'recent' | 'all' = 'open'): TicketView[] {
    const ended = `state IN (${ENDED.map(s => `'${s}'`).join(', ')})`
    const where = {
      all: '1',
      open: `NOT ${ended}`,
      needs_me: `state IN (${NEEDS_ME.map(s => `'${s}'`).join(', ')})`,
      recent: `(NOT ${ended} OR ended_at >= ?)`,
    }[filter]
    const args = filter === 'recent' ? [this.now() - 24 * 3600 * 1000] : []
    return this.rows(`WHERE ${where}`, args)
  }

  /**
   * Tickets ended or not, newest first: those whose title, task or latest
   * message holds `query`, in a project whose id holds `project`. A LIKE scan:
   * the table holds one row per task a person gave, so no index pays for itself.
   */
  searchTickets(filter: { query?: string; project?: string; limit?: number }): TicketView[] {
    const like = (s: string): string => `%${s.replace(/[\\%_]/g, c => `\\${c}`)}%`
    const where: string[] = []
    const args: string[] = []
    const query = filter.query?.trim()
    if (query) {
      where.push(
        `(t.title LIKE ?1 ESCAPE '\\' OR t.prompt LIKE ?1 ESCAPE '\\' OR t.last_report LIKE ?1 ESCAPE '\\')`,
      )
      args.push(like(query))
    }
    const project = filter.project?.trim()
    if (project) {
      where.push(`t.project_id LIKE ?${args.length + 1} ESCAPE '\\'`)
      args.push(like(project))
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 20, 100))
    return this.rows(
      where.length ? `WHERE ${where.join(' AND ')}` : '',
      args,
      `ORDER BY t.id DESC LIMIT ${limit}`,
    )
  }

  /** The tickets that carry this one on, oldest first. */
  followersOf(id: number): TicketView[] {
    return this.rows('WHERE t.follows_id = ?', [id])
  }

  ticketsInState(states: readonly TicketState[]): TicketView[] {
    const marks = states.map(() => '?').join(', ')
    return this.rows(`WHERE state IN (${marks})`, [...states])
  }

  /** Tickets matching `where`, each with its open question, in one query. */
  private rows(where: string, args: (string | number)[], order = 'ORDER BY t.id'): TicketView[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, q.id AS q_id, q.kind AS q_kind, q.question AS q_question,
                q.options AS q_options, q.asked_at AS q_asked_at
         FROM tickets t
         LEFT JOIN questions q ON q.ticket_id = t.id AND q.answered_at IS NULL
         ${where} ${order}`,
      )
      .all(...args) as (TicketRow & OpenQuestionCols)[]
    return rows.map(r => this.view(r))
  }

  setWorker(id: number, worker: { sessionId?: string; bgId?: string; cwd?: string }): void {
    this.db
      .prepare(
        `UPDATE tickets SET
           worker_session_id = COALESCE(?, worker_session_id),
           worker_bg_id = COALESCE(?, worker_bg_id),
           cwd = COALESCE(?, cwd)
         WHERE id = ?`,
      )
      .run(worker.sessionId ?? null, worker.bgId ?? null, worker.cwd ?? null, id)
  }

  /** Records the ticket's lane once made, or (null) that it was cleaned. */
  setLane(id: number, lane: { repo: string; path: string; branch: string } | null): void {
    if (lane === null) {
      this.db.prepare('UPDATE tickets SET worktree_path = NULL, branch = NULL WHERE id = ?').run(id)
      return
    }
    this.db
      .prepare('UPDATE tickets SET repo_path = ?, worktree_path = ?, branch = ? WHERE id = ?')
      .run(lane.repo, lane.path, lane.branch, id)
  }

  /**
   * The person asked for the MR. Only a ready ticket can be, so its latest
   * message is the hand-back that decision answers: 「开 MR」 shows under it.
   */
  setMrOpened(id: number): void {
    this.db
      .prepare(
        `UPDATE tickets SET mr_opened_at = COALESCE(mr_opened_at, ?), last_answer = ?
         WHERE id = ?`,
      )
      .run(this.now(), OPEN_MR_ANSWER, id)
  }

  /**
   * Takes back an MR request the Worker never received, as if never made: the
   * ticket is ready again, and its「开 MR」button back. Only while the request is
   * still the ticket's latest event: anything after it means the Worker moved.
   */
  unsetMrOpened(id: number): { ok: true; ticket: TicketView } | { ok: false; reason: string } {
    return this.tx(() => {
      const row = this.db
        .prepare('SELECT state, mr_opened_at FROM tickets WHERE id = ?')
        .get(id) as Pick<TicketRow, 'state' | 'mr_opened_at'> | undefined
      if (!row) return { ok: false, reason: `没有 ticket #${id}` }
      const last = this.db
        .prepare('SELECT id, kind FROM events WHERE ticket_id = ? ORDER BY id DESC LIMIT 1')
        .get(id) as { id: number; kind: EventKind } | undefined
      if (row.state !== 'working' || row.mr_opened_at === null || last?.kind !== 'mr_requested')
        return { ok: false, reason: `#${id} 开 MR 之后已有新动静，撤不回了` }
      this.db.prepare('DELETE FROM events WHERE id = ?').run(last.id)
      this.db
        .prepare(
          `UPDATE tickets SET state = 'ready', updated_at = ?, mr_opened_at = NULL, last_answer = NULL
           WHERE id = ?`,
        )
        .run(this.now(), id)
      return { ok: true, ticket: this.ticket(id) as TicketView }
    })
  }

  /** Ended tickets whose lane is still recorded: what a cleanup missed (a crash, a refusal). */
  unclean(): TicketView[] {
    return this.rows("WHERE state = 'done' AND worktree_path IS NOT NULL", [])
  }

  /**
   * Moves a ticket by one input and records its event, atomically. A refused
   * input changes nothing and records nothing.
   */
  apply(id: number, input: Input, actor: Actor, body: EventBody = {}): ApplyResult {
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as
        TicketRow | undefined
      if (!row) return { ok: false, reason: `没有 ticket #${id}`, ticket: null }
      const step = transition(row.state, input)
      if (!step.ok) return { ok: false, reason: step.reason, ticket: this.ticket(id) }
      const at = this.now()
      const endedAt = ENDED.includes(step.to) ? at : null
      const report = LAST_MESSAGE_INPUTS.includes(input) ? (body.text ?? null) : null
      this.db
        .prepare(
          // A new latest message drops the answer shown under the old one.
          `UPDATE tickets SET state = ?1, updated_at = ?2, ended_at = ?3,
             last_report = COALESCE(?4, last_report),
             last_answer = CASE WHEN ?4 IS NULL THEN last_answer END
           WHERE id = ?5`,
        )
        .run(step.to, at, endedAt, report, id)
      // Leaving `asking` any way but an answer (the Worker ended, was stopped,
      // or the person closed it) withdraws the question, or it would keep the
      // ticket looking answerable while nothing could take an answer.
      let withdrawnQuestionId: number | undefined
      if (row.state === 'asking' && step.to !== 'asking' && input !== 'answer') {
        const open = this.openQuestion(id)
        if (open) {
          this.db
            .prepare('UPDATE questions SET answered_at = ?, answer = NULL WHERE id = ?')
            .run(at, open.id)
          withdrawnQuestionId = open.id
        }
      }
      if (row.state === 'done' && input === 'message') this.addEvent(id, 'reopened', actor, {})
      const eventId = this.addEvent(id, EVENT_OF[input], actor, body)
      return {
        ok: true,
        ticket: this.ticket(id) as TicketView,
        eventId,
        from: row.state,
        ...(withdrawnQuestionId === undefined ? {} : { withdrawnQuestionId }),
      }
    })
  }

  // ---- events -------------------------------------------------------------

  addEvent(ticketId: number, kind: EventKind, actor: Actor, body: EventBody): number {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO events (ticket_id, ts, kind, actor, body) VALUES (?, ?, ?, ?, ?)')
      .run(ticketId, this.now(), kind, actor, JSON.stringify(body))
    return Number(lastInsertRowid)
  }

  lastEventId(): number {
    const row = this.db.prepare('SELECT MAX(id) AS id FROM events').get() as { id: number | null }
    return row.id ?? 0
  }

  /**
   * The feed. An event that hands work back to the person also carries the
   * ticket's last progress report before it (locality inline), so the Router
   * can say where the Worker had got to without a `read`.
   */
  eventsSince(cursor: number, limit = 200): EventView[] {
    const kinds = PRIOR_REPORT_KINDS.map(k => `'${k}'`).join(', ')
    const rows = this.db
      .prepare(
        `SELECT e.*, t.title, t.project_id,
           CASE WHEN e.kind IN (${kinds}) THEN (
             SELECT p.body FROM events p
             WHERE p.ticket_id = e.ticket_id AND p.kind = 'progress' AND p.id < e.id
             ORDER BY p.id DESC LIMIT 1
           ) END AS prior_body
         FROM events e JOIN tickets t ON t.id = e.ticket_id
         WHERE e.id > ? ORDER BY e.id LIMIT ?`,
      )
      .all(cursor, limit) as EventRow[]
    return rows.map(r => this.eventView(r))
  }

  /** A ticket's last `limit` events, oldest first; with `before`, those older than that event id. */
  eventsOf(
    ticketId: number,
    limit = 50,
    before = Number.MAX_SAFE_INTEGER,
  ): (EventView & { body: EventBody })[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT e.*, t.title, t.project_id FROM events e JOIN tickets t ON t.id = e.ticket_id
           WHERE e.ticket_id = ? AND e.id < ? ORDER BY e.id DESC LIMIT ?
         ) ORDER BY id`,
      )
      .all(ticketId, before, limit) as EventRow[]
    return rows.map(r => ({ ...this.eventView(r), body: JSON.parse(r.body) as EventBody }))
  }

  // ---- questions ----------------------------------------------------------

  /** Records a question and moves the ticket to `asking`, in one transaction. */
  ask(
    ticketId: number,
    question: string,
    options: string[] | null,
    permission?: { grantKey: string | null },
  ): ApplyResult & { questionId?: number } {
    return this.tx(() => {
      const kind: QuestionKind = permission ? 'permission' : 'ask'
      const body = { text: question, options, ...(permission ? { kind } : {}) }
      const moved = this.apply(ticketId, 'ask', 'worker', body)
      if (!moved.ok) return moved
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO questions (ticket_id, kind, asked_at, question, options, last_polled_at, grant_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ticketId,
          kind,
          this.now(),
          question,
          options ? JSON.stringify(options) : null,
          this.now(),
          permission?.grantKey ?? null,
        )
      return {
        ...moved,
        ticket: this.ticket(ticketId) as TicketView,
        questionId: Number(lastInsertRowid),
      }
    })
  }

  question(id: number): Question | null {
    const row = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as
      QuestionRow | undefined
    return row ? this.questionView(row) : null
  }

  openQuestion(ticketId: number): OpenQuestion | null {
    const row = this.db
      .prepare(
        'SELECT * FROM questions WHERE ticket_id = ? AND answered_at IS NULL ORDER BY id DESC LIMIT 1',
      )
      .get(ticketId) as QuestionRow | undefined
    return row ? { ...this.questionView(row), grantKey: row.grant_key } : null
  }

  /** Answers the ticket's open question and moves it back to `working`. */
  answer(ticketId: number, text: string): ApplyResult & { question?: OpenQuestion } {
    return this.tx(() => {
      const open = this.openQuestion(ticketId)
      if (!open)
        return { ok: false, reason: `#${ticketId} 没有待答问题`, ticket: this.ticket(ticketId) }
      const moved = this.apply(ticketId, 'answer', 'you', { text, questionId: open.id })
      if (!moved.ok) return moved
      this.db
        .prepare('UPDATE questions SET answered_at = ?, answer = ? WHERE id = ?')
        .run(this.now(), text, open.id)
      // Shown under the latest message only when that message is this question:
      // the Worker may have reported since it asked. A permission answer says
      // only which way it went; a bare pick says the option it picked.
      const shown =
        open.kind === 'permission'
          ? isApproval(text)
            ? APPROVE
            : REJECT
          : ((open.options && pickedOption(text, open.options)) ?? text)
      this.db
        .prepare('UPDATE tickets SET last_answer = ? WHERE id = ? AND last_report = ?')
        .run(cut(shown, ANSWER_CHARS).text, ticketId, open.question)
      return { ...moved, ticket: this.ticket(ticketId) as TicketView, question: open }
    })
  }

  // ---- views --------------------------------------------------------------

  private view(row: TicketRow & OpenQuestionCols): TicketView {
    return {
      id: row.id,
      title: row.title,
      project: row.project_id,
      cwd: row.cwd,
      state: row.state,
      needsMe: NEEDS_ME.includes(row.state),
      model: row.model,
      worktree: row.worktree === 1,
      readonly: row.readonly === 1,
      branch: row.branch,
      worktreePath: row.worktree_path,
      repoPath: row.repo_path,
      mrOpened: row.mr_opened_at !== null,
      workerName: row.worker_name,
      workerSessionId: row.worker_session_id,
      workerBgId: row.worker_bg_id,
      lastReport: row.last_report,
      lastAnswer: row.last_answer,
      followsId: row.follows_id,
      openQuestion:
        row.q_id !== null
          ? {
              id: row.q_id,
              ticketId: row.id,
              kind: row.q_kind ?? 'ask',
              question: row.q_question as string,
              options: row.q_options ? (JSON.parse(row.q_options) as string[]) : null,
              askedAt: row.q_asked_at as number,
              answeredAt: null,
              answer: null,
            }
          : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      endedAt: row.ended_at,
    }
  }

  private eventView(row: EventRow): EventView {
    const body = JSON.parse(row.body) as EventBody
    const options = Array.isArray(body.options)
      ? ` 选项：${(body.options as string[]).join(' / ')}`
      : ''
    const { text, isCut } = cut(`${body.text ?? ''}${options}`, this.inlineChars)
    const prior = row.prior_body ? (JSON.parse(row.prior_body) as EventBody).text : undefined
    return {
      id: row.id,
      ticketId: row.ticket_id,
      ts: row.ts,
      kind: row.kind,
      actor: row.actor,
      summary: text,
      isCut,
      priorReport: prior ? cut(prior, this.inlineChars).text : null,
      ticket: { id: row.ticket_id, title: row.title, project: row.project_id },
    }
  }

  private questionView(row: QuestionRow): Question {
    return {
      id: row.id,
      ticketId: row.ticket_id,
      kind: row.kind,
      question: row.question,
      options: row.options ? (JSON.parse(row.options) as string[]) : null,
      askedAt: row.asked_at,
      answeredAt: row.answered_at,
      answer: row.answer,
    }
  }
}
