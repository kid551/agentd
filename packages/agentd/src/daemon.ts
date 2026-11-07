import { EventEmitter } from 'node:events'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isWorkerGone, type SpawnSpec, type WorkerInfo, type WorkerRuntime } from './claude.js'
import { deliveryOf, type Config, type Paths } from './config.js'
import { laneModeOf } from './lane-rules.js'
import {
  forgeOf,
  GitLanes,
  laneFor,
  whyLocal,
  type CleanMode,
  type Lane,
  type Lanes,
} from './lanes.js'
import { GRANT_TTL_MS, isApproval, workerSettings } from './permission.js'
import { resolveProject, scanRoots } from './projects.js'
import type { Input } from './state.js'
import type { ApplyResult, Store } from './store.js'
import { type Activity, findTranscript, readActivity, readRow, readRows } from './transcript.js'
import {
  ACTIVE,
  OCCUPYING,
  type AnswerResult,
  type DispatchInput,
  type Outcome,
  type Project,
  type ResolveResult,
  type TicketView,
  type TranscriptPage,
  type TranscriptRow,
} from './types.js'
import { workerPrompt } from './worker-prompt.js'

export type DaemonOptions = {
  store: Store
  runtime: WorkerRuntime
  config: Config
  paths: Paths
  /** The Worker-side MCP server script; defaults to the bundle's sibling. */
  mcpScript?: string
  /** The Worker's permission hook script; defaults to the bundle's sibling. */
  hookScript?: string
  /** Git worktrees for MR tickets; tests give a fake. */
  lanes?: Lanes
  now?: () => number
  log?: (line: string) => void
}

export type DispatchResult =
  /** `note`: why a project set to mr took the ticket in its own folder. */
  | { ok: true; ticket: TicketView; note?: string }
  | { ok: false; reason: string; resolve: ResolveResult }

export type AnswerWait = { answered: boolean; answer: string | null; withdrawn: boolean }

const RESCAN_MS = 10 * 60_000

export class Daemon {
  readonly store: Store
  readonly bus = new EventEmitter()
  private readonly runtime: WorkerRuntime
  private readonly lanes: Lanes
  private readonly config: Config
  private readonly paths: Paths
  private readonly mcpScript: string
  private readonly hookScript: string
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly waiters = new Map<number, Set<(answer: string | null) => void>>()
  /** Approved refused calls per ticket, each good for one retry until it expires. */
  private readonly grants = new Map<number, { key: string; at: number }[]>()
  private readonly launching = new Set<number>()
  private readonly idleSince = new Map<number, number>()
  private lastScan = 0
  private ticking = false
  lastActivity: number

  constructor(options: DaemonOptions) {
    this.store = options.store
    this.runtime = options.runtime
    this.lanes = options.lanes ?? new GitLanes()
    this.config = options.config
    this.paths = options.paths
    this.mcpScript =
      options.mcpScript ?? fileURLToPath(new URL('./agentd-mcp.mjs', import.meta.url))
    this.hookScript =
      options.hookScript ?? fileURLToPath(new URL('./agentd-hook.mjs', import.meta.url))
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => {})
    this.lastActivity = this.now()
    this.bus.setMaxListeners(0)
  }

  private changed(): void {
    this.bus.emit('event')
  }

  // ---- projects -----------------------------------------------------------

  rescan(): Project[] {
    const projects = scanRoots(this.config.roots, this.config.scanDepth)
    this.store.replaceProjects(projects)
    this.lastScan = this.now()
    this.log(`scanned ${projects.length} projects under ${this.config.roots.join(', ')}`)
    return projects
  }

  // ---- Router side --------------------------------------------------------

  dispatch(input: DispatchInput): DispatchResult {
    const resolved = resolveProject(input.project, this.store.listProjects())
    if (resolved.kind !== 'found') {
      const names = (resolved.kind === 'ambiguous' ? resolved.candidates : resolved.suggestions)
        .map(p => p.id)
        .join('、')
      const reason =
        resolved.kind === 'ambiguous'
          ? `「${input.project}」对应多个项目：${names}。请问用户是哪一个。`
          : `没有叫「${input.project}」的项目。${names ? `相近的有：${names}。` : ''}请问用户。`
      return { ok: false, reason, resolve: resolved }
    }
    // A follows naming no ticket is a slip in the Router's recall: the task
    // itself is fine, so it goes out without the link and the Router is told.
    const follows =
      input.follows !== undefined && this.store.ticket(input.follows) ? input.follows : undefined
    const followNote =
      input.follows !== undefined && follows === undefined
        ? `没有 ticket #${input.follows}，没记接续关系`
        : undefined
    const readonly = input.readonly === true
    const lane = readonly ? { worktree: false } : this.wantsLane(resolved.project.path)
    const ticket = this.store.createTicket({
      title: input.title.trim().slice(0, 60),
      project: resolved.project,
      prompt: input.prompt,
      model: input.model ?? this.config.worker.model,
      // A writing ticket in an MR project gets its own lane; nothing else does.
      worktree: lane.worktree,
      readonly,
      ...(follows === undefined ? {} : { followsId: follows }),
    })
    if (lane.note) this.log(`ticket #${ticket.id}: ${lane.note}`)
    this.changed()
    void this.tick()
    const note = [lane.note, followNote].filter(Boolean).join('；')
    return note ? { ok: true, ticket, note } : { ok: true, ticket }
  }

  /**
   * Whether a writing ticket here gets a lane: the project is set to mr, and
   * its clone has what an MR needs. Read locally, so dispatch never waits on
   * the network; a project that cannot goes on as local and says why.
   */
  private wantsLane(path: string): { worktree: boolean; note?: string } {
    if (deliveryOf(this.config, path) !== 'mr') return { worktree: false }
    const why = whyLocal(this.lanes.probe(path), this.config.githubOwners)
    return why === null
      ? { worktree: true }
      : { worktree: false, note: `配置为 MR 项目，但${why}，按串行在项目目录里做` }
  }

  answer(
    ticketId: number,
    text: string,
  ): { ok: true; result: AnswerResult } | { ok: false; reason: string } {
    const done = this.store.answer(ticketId, text)
    if (!done.ok || !done.question)
      return { ok: false, reason: done.ok ? '没有待答问题' : done.reason }
    // Granted here, not in the hook: a late answer still lets the retry through,
    // and only the daemon decides what is granted.
    if (done.question.grantKey && isApproval(text)) this.grant(ticketId, done.question.grantKey)
    // A permission question's hook fetches its answer from here, even across a
    // daemon restart. An `ask` returned at once, so the mod sends its answer to
    // the Worker as a message, unless a Worker started before asks stopped
    // waiting (偏差 47) still waits on it.
    const set = this.waiters.get(done.question.id)
    const hadWaiter = done.question.kind === 'permission' || (set !== undefined && set.size > 0)
    this.release(done.question.id, text)
    this.changed()
    return {
      ok: true,
      result: { questionId: done.question.id, hadWaiter, workerName: done.ticket.workerName },
    }
  }

  /** Records a message the mod is about to send the Worker, waking a stopped ticket. */
  message(ticketId: number, text: string, actor: 'you' | 'router' = 'router'): ApplyResult {
    const ticket = this.store.ticket(ticketId)
    // close stopped this Worker, so nobody would receive the message; an MR
    // ticket that ended had its Worker stopped and its lane removed.
    if (
      ticket?.state === 'done' &&
      (ticket.worktree || this.store.eventsOf(ticketId, 1)[0]?.kind === 'closed')
    ) {
      return {
        ok: false,
        reason: `#${ticketId} 已收，Worker 已停。要继续改请派新 ticket，可在 prompt 里引用 #${ticketId} 的交付。`,
        ticket,
      }
    }
    const moved = this.store.apply(ticketId, 'message', actor, { text })
    if (moved.ok) {
      this.idleSince.delete(ticketId)
      this.changed()
    }
    return moved
  }

  /**
   * Accepting a ticket ends its Worker too, so idle Workers do not pile up. An
   * MR ticket ends by its merge; closing one before is giving its change up,
   * so it takes `discard`, the person's confirmation, and removes the lane.
   */
  async close(ticketId: number, discard = false): Promise<ApplyResult> {
    const ticket = this.store.ticket(ticketId)
    if (ticket?.worktreePath && !discard) {
      return {
        ok: false,
        reason: `#${ticketId} 的改动还没合入 main。收 = 放弃这份改动，删掉 worktree 和分支 ${ticket.branch ?? ''}。先跟用户确认，确认后带 discard=true 再收。`,
        ticket,
      }
    }
    const moved = this.store.apply(ticketId, 'close', 'you')
    if (!moved.ok) return moved
    this.settled(moved)
    if (moved.ticket.worktreePath) {
      await this.finish(moved.ticket, 'discard')
      return { ...moved, ticket: this.store.ticket(ticketId) as TicketView }
    }
    const bgId = moved.ticket.workerBgId
    if (bgId) await this.runtime.stop(bgId).catch((error: unknown) => this.log(String(error)))
    return moved
  }

  /**
   * The person approved what an MR ticket's Worker handed back. Recorded before
   * the mod tells the Worker, which checks the record (mr_consent) before it
   * commits; `undoOpenMr` takes it back if the words could not be delivered.
   */
  openMr(ticketId: number): ApplyResult {
    const ticket = this.store.ticket(ticketId)
    if (!ticket) return { ok: false, reason: `没有 ticket #${ticketId}`, ticket: null }
    if (!ticket.worktreePath)
      return { ok: false, reason: `#${ticketId} 不是 MR 奏折，没有 MR 可开`, ticket }
    const moved = this.store.tx(() => {
      const applied = this.store.apply(ticketId, 'open_mr', 'you', { text: '开 MR' })
      if (applied.ok) this.store.setMrOpened(ticketId)
      return applied.ok
        ? { ...applied, ticket: this.store.ticket(ticketId) as TicketView }
        : applied
    })
    if (moved.ok) {
      this.idleSince.delete(ticketId)
      this.changed()
    }
    return moved
  }

  /** The mod could not tell the Worker to open the MR: the ticket waits for review again. */
  undoOpenMr(ticketId: number): ApplyResult {
    const undone = this.store.unsetMrOpened(ticketId)
    if (!undone.ok) return { ...undone, ticket: this.store.ticket(ticketId) }
    this.changed()
    return { ok: true, ticket: undone.ticket, eventId: this.store.lastEventId(), from: 'working' }
  }

  /**
   * Ends a ticket's lane: its Worker is stopped first (it sits in the folder),
   * then the worktree and branch go. A lane that could not go safely is kept
   * and the person told, with why.
   */
  private async finish(ticket: TicketView, mode: CleanMode): Promise<void> {
    if (ticket.workerBgId)
      await this.runtime.stop(ticket.workerBgId).catch((e: unknown) => this.log(String(e)))
    const lane = this.laneOf(ticket)
    if (!lane) return
    let cleaned: { removed: boolean; text: string }
    try {
      cleaned = await this.lanes.clean(lane, mode)
    } catch (error) {
      cleaned = { removed: false, text: `保留了 ${lane.path}：${String(error).slice(0, 300)}` }
    }
    if (cleaned.removed) this.store.setLane(ticket.id, null)
    this.store.addEvent(ticket.id, cleaned.removed ? 'cleaned' : 'kept', 'agentd', {
      text: cleaned.text,
    })
    this.log(`ticket #${ticket.id}: ${cleaned.text}`)
    this.changed()
  }

  private laneOf(ticket: TicketView): Lane | null {
    return ticket.worktreePath && ticket.branch && ticket.repoPath
      ? { repo: ticket.repoPath, path: ticket.worktreePath, branch: ticket.branch }
      : null
  }

  /**
   * At start: lanes of ended tickets a cleanup missed (the daemon died between
   * the merge and the cleanup, or one was kept). A merged one is cleaned as
   * merged, so a kept worktree with work in it stays kept.
   */
  async sweep(): Promise<void> {
    for (const ticket of this.store.unclean()) {
      const ended = this.store
        .eventsOf(ticket.id, 20)
        .findLast(e => e.kind === 'merged' || e.kind === 'closed' || e.kind === 'dropped')
      const lane = this.laneOf(ticket)
      if (!lane) continue
      try {
        const cleaned = await this.lanes.clean(
          lane,
          ended?.kind === 'merged' ? 'merged' : 'discard',
        )
        if (cleaned.removed) {
          this.store.setLane(ticket.id, null)
          this.store.addEvent(ticket.id, 'cleaned', 'agentd', { text: cleaned.text })
          this.changed()
        }
        this.log(`sweep #${ticket.id}: ${cleaned.text}`)
      } catch (error) {
        this.log(`sweep #${ticket.id} failed: ${String(error)}`)
      }
    }
  }

  async stop(ticketId: number): Promise<ApplyResult> {
    const moved = this.store.apply(ticketId, 'stop', 'you')
    if (moved.ok) {
      if (moved.ticket.workerBgId) await this.runtime.stop(moved.ticket.workerBgId)
      this.settled(moved)
    }
    return moved
  }

  /**
   * A ticket whose Worker never started goes back in the queue. One whose Worker
   * handed back blocked or failed is relaunched on its own conversation, so it
   * runs with the current Worker setup (permission hooks included) and retries.
   */
  async retry(ticketId: number): Promise<ApplyResult> {
    const ticket = this.store.ticket(ticketId)
    if (ticket?.workerBgId) {
      if (ticket.workerSessionId && (ticket.state === 'blocked' || ticket.state === 'failed')) {
        return this.relaunch(
          ticket,
          ticket.workerSessionId,
          `【agentd ticket #${ticket.id} 重启】你的会话被 agentd 重新启动，现在被自动审查拒绝的操作会转给用户批准。从上次停下的地方继续：如果上次是因为权限被拒而停下，现在把那一步原样再做一次。做完照常调用 done。`,
          `重启 Worker，接着做`,
        )
      }
      return { ok: false, reason: this.whyNoRetry(ticket), ticket }
    }
    const moved = this.store.apply(ticketId, 'retry', 'you')
    if (moved.ok) {
      this.changed()
      void this.tick()
    }
    return moved
  }

  /** Why a ticket with a Worker cannot be retried, naming what to do instead. */
  private whyNoRetry(ticket: TicketView): string {
    if (ticket.state === 'stopped')
      return `#${ticket.id} 已停，要接着做请用 resume（面板上的「恢复」）`
    if (ticket.state === 'done') return `#${ticket.id} 已结束，要继续改请派新 ticket`
    if (!ticket.workerSessionId) return `#${ticket.id} 的 Worker 会话还没就绪，稍后再试`
    return `#${ticket.id} 的 Worker 还在，给它发消息即可`
  }

  /**
   * A ticket the person stopped midway goes on: its conversation is relaunched,
   * told it was cut off, and made to look before it touches anything. Its
   * project was freed by the stop, so it must be free again, and a Worker slot.
   */
  async resume(ticketId: number): Promise<ApplyResult> {
    const ticket = this.store.ticket(ticketId)
    const refuse = (reason: string): ApplyResult => ({ ok: false, reason, ticket })
    if (!ticket) return { ok: false, reason: `没有 ticket #${ticketId}`, ticket: null }
    if (ticket.state !== 'stopped') {
      return refuse(
        ticket.state === 'blocked' || ticket.state === 'failed'
          ? `#${ticketId} 不是已停，是 ${ticket.state}，用 retry`
          : `#${ticketId} 不是已停（${ticket.state}），不用恢复`,
      )
    }
    if (!ticket.workerBgId || !ticket.workerSessionId) {
      return refuse(`#${ticketId} 的 Worker 从没启动过，没有会话可恢复，请派新 ticket`)
    }
    if (!existsSync(ticket.cwd)) return refuse(`#${ticketId} 的目录 ${ticket.cwd} 已不存在`)
    if (holdsProject(ticket)) {
      const holder = this.store
        .ticketsInState(OCCUPYING)
        .find(
          t => t.id !== ticketId && holdsProject(t) && t.workerBgId && t.project === ticket.project,
        )
      if (holder) return refuse(`${ticket.project} 正被 #${holder.id} 占用，先收或停掉它`)
    }
    const active = this.store.ticketsInState(ACTIVE).length + this.launching.size
    if (active >= this.config.worker.maxConcurrent) {
      return refuse(`Worker 已满（${this.config.worker.maxConcurrent} 个），等一个结束再恢复`)
    }
    return this.relaunch(
      ticket,
      ticket.workerSessionId,
      `【agentd ticket #${ticket.id} 恢复】用户中途停止过你，现在 agentd 接着你原来的会话重新启动了你（被自动审查拒绝的操作会转给用户批准）。停下时你可能正做到某一步的中途，现场可能是半途状态。\n\n1. 先只读自查：你最后在做的那一步实际做到了哪里，相关的 git、远端、部署等外部状态现在是什么样。\n2. 用 report 汇报做到哪了、还剩什么。\n3. 再用 ask 问用户下一步怎么做，然后结束本轮等回答（不要调用 done）。\n\n得到回答之前不做任何写操作：不改文件、不提交、不推送、不部署。`,
      '恢复',
      'resume',
    )
  }

  /**
   * The person's own words for a Worker that has stopped (blocked or failed),
   * typed in a chat. A message from another session is not the person to the
   * Worker's permission review, so these resume its conversation as a user turn
   * instead: an approval said here counts as said in that session.
   */
  async say(ticketId: number, text: string): Promise<ApplyResult> {
    const ticket = this.store.ticket(ticketId)
    if (!ticket?.workerSessionId || (ticket.state !== 'blocked' && ticket.state !== 'failed')) {
      return {
        ok: false,
        reason: `#${ticketId} 的 Worker 不在受阻或失败状态，直接发消息即可`,
        ticket: ticket ?? null,
      }
    }
    return this.relaunch(
      ticket,
      ticket.workerSessionId,
      `【agentd ticket #${ticket.id}】以下是用户本人在 Router 的单聊里亲手打的字，由 agentd 原样送进你的会话，没有经过 Router 转述：\n\n${text}`,
      text,
    )
  }

  private async relaunch(
    ticket: TicketView,
    sessionId: string,
    prompt: string,
    note: string,
    input: Input = 'message',
  ): Promise<ApplyResult> {
    if (this.launching.has(ticket.id)) {
      return { ok: false, reason: `#${ticket.id} 正在重启`, ticket }
    }
    this.launching.add(ticket.id)
    try {
      // `--resume` on a running session starts a copy; stop it first.
      await this.runtime
        .stop(ticket.workerBgId as string)
        .catch((e: unknown) => this.log(String(e)))
      const result = await this.runtime.spawn({
        ...this.workerSpec(ticket),
        resume: sessionId,
        taskPrompt: prompt,
      })
      if (!result.ok) {
        this.log(`ticket #${ticket.id} failed to relaunch: ${result.reason}`)
        return { ok: false, reason: result.reason, ticket }
      }
      const moved = this.store.tx(() => {
        this.store.setWorker(ticket.id, { bgId: result.bgId })
        return this.store.apply(ticket.id, input, 'you', { text: note })
      })
      this.idleSince.delete(ticket.id)
      this.log(`ticket #${ticket.id} relaunched as ${result.bgId}`)
      this.changed()
      return moved
    } finally {
      this.launching.delete(ticket.id)
    }
  }

  /** The Worker's rows before byte `before` (the end when absent); null without a transcript. */
  transcript(ticketId: number, limit: number, before?: number): TranscriptPage | null {
    const file = this.transcriptFile(ticketId)
    return file ? readRows(file, { limit, ...(before === undefined ? {} : { before }) }) : null
  }

  /** One row of the Worker's transcript whole, by the offset its page gave. */
  transcriptRow(ticketId: number, at: number): TranscriptRow | null {
    const file = this.transcriptFile(ticketId)
    return file ? readRow(file, at) : null
  }

  private transcriptFile(ticketId: number): string | null {
    const ticket = this.store.ticket(ticketId)
    return ticket?.workerSessionId ? findTranscript(ticket.workerSessionId) : null
  }

  /** The last lines each working Worker wrote, so the person can see it is alive. */
  activity(): ({ ticketId: number } & Activity)[] {
    const out: ({ ticketId: number } & Activity)[] = []
    for (const ticket of this.store.ticketsInState(['working'])) {
      if (!ticket.workerSessionId) continue
      const file = findTranscript(ticket.workerSessionId)
      if (!file) continue
      try {
        out.push({ ticketId: ticket.id, ...readActivity(file) })
      } catch {
        // A transcript that vanished between finding and reading shows nothing.
      }
    }
    return out
  }

  // ---- Worker side --------------------------------------------------------

  report(ticketId: number, text: string): ApplyResult {
    const moved = this.store.apply(ticketId, 'report', 'worker', { text })
    if (moved.ok) {
      this.idleSince.delete(ticketId)
      this.changed()
    }
    return moved
  }

  ask(
    ticketId: number,
    question: string,
    options: string[] | null,
    permission?: { grantKey: string | null },
  ) {
    const asked = this.store.ask(ticketId, question, options, permission)
    if (asked.ok) this.changed()
    return asked
  }

  private grantFlag(ticketId: number): string {
    return join(this.paths.mcpDir, `${ticketId}.grant`)
  }

  /** Keeps the flag file the Worker's PreToolUse hook tests in step with its grants. */
  private syncGrants(ticketId: number): { key: string; at: number }[] {
    const live = (this.grants.get(ticketId) ?? []).filter(g => this.now() - g.at < GRANT_TTL_MS)
    if (live.length > 0) {
      this.grants.set(ticketId, live)
      writeFileSync(this.grantFlag(ticketId), String(live.length))
    } else {
      this.grants.delete(ticketId)
      rmSync(this.grantFlag(ticketId), { force: true })
    }
    return live
  }

  private grant(ticketId: number, key: string): void {
    this.grants.set(ticketId, [...(this.grants.get(ticketId) ?? []), { key, at: this.now() }])
    this.syncGrants(ticketId)
  }

  /** Lets one approved call through, once: true consumes the grant. */
  takeGrant(ticketId: number, key: string): boolean {
    const live = this.syncGrants(ticketId)
    const at = live.findIndex(g => g.key === key)
    if (at < 0) return false
    this.grants.set(
      ticketId,
      live.filter((_, i) => i !== at),
    )
    this.syncGrants(ticketId)
    return true
  }

  /**
   * Waits up to `waitMs` for a question's answer. A Worker's permission hook
   * calls this in a loop, so the daemon may restart between calls and lose
   * nothing. A question withdrawn (its ticket left `asking` unanswered) ends it.
   */
  waitAnswer(questionId: number, waitMs: number): Promise<AnswerWait> {
    const question = this.store.question(questionId)
    if (!question) return Promise.resolve({ answered: false, answer: null, withdrawn: true })
    if (question.answeredAt !== null) {
      return Promise.resolve(
        question.answer === null
          ? { answered: false, answer: null, withdrawn: true }
          : { answered: true, answer: question.answer, withdrawn: false },
      )
    }
    return new Promise(resolve => {
      const set = this.waiters.get(questionId) ?? new Set()
      this.waiters.set(questionId, set)
      const finish = (answer: string | null, withdrawn = false): void => {
        clearTimeout(timer)
        set.delete(onAnswer)
        resolve({ answered: answer !== null, answer, withdrawn })
      }
      const onAnswer = (answer: string | null): void => finish(answer, answer === null)
      const timer = setTimeout(() => finish(null), waitMs)
      set.add(onAnswer)
    })
  }

  /** Wakes whoever waits on a question, with its answer or (null) its withdrawal. */
  private release(questionId: number, answer: string | null): void {
    for (const resolve of this.waiters.get(questionId) ?? []) resolve(answer)
    this.waiters.delete(questionId)
  }

  /** After a store change: wakes a Worker whose question was withdrawn, tells the feed. */
  private settled(moved: ApplyResult): void {
    if (!moved.ok) return
    if (moved.withdrawnQuestionId !== undefined) this.release(moved.withdrawnQuestionId, null)
    this.changed()
  }

  async done(ticketId: number, outcome: Outcome, summary: string): Promise<ApplyResult> {
    const ticket = this.store.ticket(ticketId)
    if (outcome === 'merged') {
      const refused = await this.whyNotMerged(ticket)
      if (refused) return { ok: false, reason: refused, ticket }
    }
    const input = `done_${outcome}` as const
    const moved = this.store.apply(ticketId, input, 'worker', { text: summary })
    if (moved.ok) {
      this.idleSince.delete(ticketId)
      this.settled(moved)
      // The lane goes once its work is in main, or once there is no work.
      // After the reply: the Worker is stopped, and this call is its last.
      if (moved.ticket.worktreePath && (outcome === 'merged' || outcome === 'dropped')) {
        const ended = moved.ticket
        setImmediate(() => {
          void this.finish(ended, outcome === 'merged' ? 'merged' : 'discard').then(() =>
            this.tick(),
          )
        })
      }
    }
    return moved
  }

  /**
   * A merge is checked, not taken on the Worker's word: the MR was asked for,
   * and origin no longer has the branch (the MR deletes it as it merges; a
   * closed MR leaves it). Merges are squashed, so main's history cannot say.
   */
  private async whyNotMerged(ticket: TicketView | null): Promise<string | null> {
    if (!ticket) return '没有这个 ticket'
    const lane = this.laneOf(ticket)
    if (!lane || !ticket.mrOpened)
      return 'merged 只用于用户要求开 MR 之后。没有合入就用 ready / blocked / failed。'
    try {
      if (await this.lanes.hasRemoteBranch(lane)) {
        return `origin 上还有分支 ${lane.branch}：MR 还没合入，或没有设「合入后删除源分支」。合入（并删掉源分支）后再 done(merged)。`
      }
    } catch (error) {
      return `问不到 origin 上有没有 ${lane.branch}（${String(error).slice(0, 200)}），稍后再试。`
    }
    return null
  }

  // ---- event feed ---------------------------------------------------------

  /** Events after `cursor`, waiting up to `waitMs` for the first one. */
  async eventsSince(cursor: number, waitMs: number) {
    const ready = this.store.eventsSince(cursor)
    if (ready.length > 0 || waitMs <= 0) return ready
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, waitMs)
      function done(): void {
        clearTimeout(timer)
        resolve()
      }
      this.bus.once('event', done)
    })
    return this.store.eventsSince(cursor)
  }

  // ---- supervisor ---------------------------------------------------------

  /** One pass: rescan when due, follow Workers, launch what the queue allows. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      if (this.now() - this.lastScan > RESCAN_MS) this.rescan()
      await this.follow()
      this.launchQueued()
    } catch (error) {
      this.log(`tick failed: ${String(error)}`)
    } finally {
      this.ticking = false
    }
  }

  private async follow(): Promise<void> {
    const live = this.store.ticketsInState(ACTIVE)
    if (live.length === 0) return
    let workers: WorkerInfo[]
    try {
      workers = await this.runtime.list()
    } catch (error) {
      this.log(String(error))
      return
    }
    const byName = new Map<string, WorkerInfo>()
    for (const w of workers) {
      const seen = byName.get(w.name)
      if (!seen || w.startedAt > seen.startedAt) byName.set(w.name, w)
    }
    const now = this.now()
    for (const ticket of live) {
      if (this.launching.has(ticket.id)) continue
      const worker = byName.get(ticket.workerName)
      if (!worker || isWorkerGone(worker)) {
        // Give a just-launched Worker time to appear in the list.
        if (ticket.workerBgId && now - ticket.updatedAt > 20_000) {
          const why = worker ? `Worker 进程已结束（${worker.state}）` : 'Worker 进程不见了'
          this.settled(
            this.store.apply(ticket.id, 'exited', 'agentd', { text: `${why}，且没有调用 done。` }),
          )
        }
        continue
      }
      if (worker.sessionId !== ticket.workerSessionId || worker.cwd !== ticket.cwd) {
        this.store.setWorker(ticket.id, {
          sessionId: worker.sessionId,
          bgId: worker.id,
          cwd: worker.cwd,
        })
        this.changed()
      }
      if (worker.status === 'busy' || ticket.state !== 'working') {
        this.idleSince.delete(ticket.id)
        continue
      }
      const since = this.idleSince.get(ticket.id) ?? now
      this.idleSince.set(ticket.id, since)
      if (now - since >= this.config.stallSeconds * 1000) {
        this.idleSince.delete(ticket.id)
        this.store.apply(ticket.id, 'stalled', 'agentd', {
          text: 'Worker 已停下但没有调用 done，可能在它自己的会话里等人。打开它看看，或给它发消息。',
        })
        this.changed()
      }
    }
  }

  private launchQueued(): void {
    const active = this.store.ticketsInState(ACTIVE)
    let slots = this.config.worker.maxConcurrent - active.length - this.launching.size
    // A ticket keeps its project until closed or stopped: its Worker may still
    // hold uncommitted work there, and a message can set it going again.
    const busy = new Set(
      this.store
        .ticketsInState(OCCUPYING)
        .filter(t => holdsProject(t) && t.workerBgId)
        .map(t => t.project),
    )
    // A stopped ticket being resumed is not in OCCUPYING yet, but its Worker is coming.
    for (const id of this.launching) {
      const t = this.store.ticket(id)
      if (t && holdsProject(t)) busy.add(t.project)
    }
    for (const ticket of this.store.ticketsInState(['queued'])) {
      if (this.launching.has(ticket.id)) continue
      if (slots <= 0) break
      if (holdsProject(ticket) && busy.has(ticket.project)) continue
      if (holdsProject(ticket)) busy.add(ticket.project)
      slots--
      this.launching.add(ticket.id)
      void this.launch(ticket).finally(() => this.launching.delete(ticket.id))
    }
  }

  /** What every Worker of a ticket runs with: its MCP server, its hooks, its rules. */
  private workerSpec(ticket: TicketView): Omit<SpawnSpec, 'taskPrompt'> {
    const url = `http://127.0.0.1:${this.config.port}`
    const mcpConfigPath = join(this.paths.mcpDir, `${ticket.id}.json`)
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          agentd: {
            type: 'stdio',
            command: process.execPath,
            args: [this.mcpScript],
            env: { AGENTD_URL: url, AGENTD_TICKET: String(ticket.id) },
          },
        },
      }),
    )
    return {
      name: ticket.workerName,
      cwd: ticket.cwd,
      model: ticket.model,
      permissionMode: this.config.worker.permissionMode,
      mcpConfigPath,
      // A readonly Worker runs like any other, without the file-writing tools.
      // Not plan mode: in a background session plan mode asks before a write
      // and before an agentd tool too, and nobody is there to answer
      // (implementation-notes 偏差 P1). Its Bash is held by its rules only.
      ...(ticket.readonly ? { disallowedTools: READONLY_REFUSED } : {}),
      settings: workerSettings({
        node: process.execPath,
        script: this.hookScript,
        url,
        ticket: ticket.id,
        flag: this.grantFlag(ticket.id),
      }),
      systemPrompt: workerPrompt({
        ...ticket,
        lane: laneModeOf(
          ticket,
          ticket.worktree && ticket.repoPath
            ? forgeOf(this.lanes.probe(ticket.repoPath).url)
            : undefined,
        ),
      }),
    }
  }

  /** Makes an MR ticket's lane (or finds it from a start that failed later) and moves the ticket into it. */
  private async enterLane(ticket: TicketView): Promise<TicketView> {
    if (!ticket.worktree) return ticket
    const lane =
      this.laneOf(ticket) ??
      laneFor(ticket.repoPath ?? ticket.cwd, 'agentd', ticket.id, ticket.createdAt)
    await this.lanes.create(lane)
    this.store.tx(() => {
      this.store.setLane(ticket.id, lane)
      this.store.setWorker(ticket.id, { cwd: lane.path })
    })
    return this.store.ticket(ticket.id) as TicketView
  }

  private async launch(queued: TicketView): Promise<void> {
    let ticket: TicketView
    try {
      ticket = await this.enterLane(queued)
    } catch (error) {
      const reason = `建 worktree 失败：${String(error).slice(0, 500)}`
      this.store.apply(queued.id, 'spawn_fail', 'agentd', { text: reason })
      this.log(`ticket #${queued.id} failed to launch: ${reason}`)
      this.changed()
      return
    }
    const prompt = this.store.ticketPrompt(ticket.id) ?? ''
    const result = await this.runtime.spawn({
      ...this.workerSpec(ticket),
      taskPrompt: `【agentd ticket #${ticket.id}】${ticket.title}\n\n${prompt}`,
    })
    if (result.ok) {
      this.store.tx(() => {
        this.store.setWorker(ticket.id, { bgId: result.bgId })
        this.store.apply(ticket.id, 'spawn_ok', 'agentd', { text: `Worker ${result.bgId} 已启动` })
      })
      this.log(`ticket #${ticket.id} launched as ${result.bgId}`)
    } else {
      this.store.apply(ticket.id, 'spawn_fail', 'agentd', { text: result.reason })
      this.log(`ticket #${ticket.id} failed to launch: ${result.reason}`)
    }
    this.changed()
  }

  /** True when nothing would happen without a new request. */
  isIdle(): boolean {
    return (
      this.store.ticketsInState(['queued', 'working', 'asking']).length === 0 &&
      this.launching.size === 0
    )
  }
}

/** Tools a readonly Worker does not get. */
export const READONLY_REFUSED = ['Edit', 'Write', 'NotebookEdit']

/** Writes in the project folder itself: one such ticket per project at a time. */
const holdsProject = (t: TicketView): boolean => !t.worktree && !t.readonly
