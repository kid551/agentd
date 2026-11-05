import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

import { matchDelivery, type Delivery } from '../../../agentd/src/config.js'
import { mrConsentAnswer, openMrText } from '../../../agentd/src/lane-rules.js'
import {
  GitLanes,
  laneFor,
  type CleanMode,
  type Lane,
  type Lanes,
} from '../../../agentd/src/lanes.js'
import { resolveProject, scanRoots } from '../../../agentd/src/projects.js'
import { ACTIVE, ENDED, OCCUPYING, STATE_WORDS, type Input } from '../core/state.js'
import {
  RESUME_TEXT,
  RETRY_TEXT,
  cut,
  digest,
  header,
  messageText,
  overview,
  taskText,
  userSaidNote,
} from '../core/text.js'
import type { Outcome, Project, Ticket } from '../core/types.js'
import type { Board } from './board.js'
import type { RouterLink, WorkerRuntime } from './runtime.js'

export type ServiceConfig = {
  roots: string[]
  scanDepth: number
  maxConcurrent: number
  inlineChars: number
  /** A Worker idle this long in `working` without calling done counts as stalled. */
  stallMs: number
  /** Events wait this long for company before the Router is woken (batching). */
  quietMs: number
  workerPreset: string
  /**
   * Delivery per repository or folder (real paths; the nearest key wins), as
   * agentd's `projects`: writing tickets in an `mr` project get their own lane.
   */
  projects: Record<string, { delivery: Delivery }>
  defaultDelivery: Delivery
}

export const DEFAULT_CONFIG: ServiceConfig = {
  roots: [],
  scanDepth: 3,
  maxConcurrent: 4,
  inlineChars: 300,
  stallMs: 60_000,
  quietMs: 1_500,
  workerPreset: 'standard',
  projects: {},
  defaultDelivery: 'local',
}

/** Outcome of an action, phrased for the Router model and the board's toast. */
export type Result = { ok: true; text: string } | { ok: false; text: string }

const ok = (text: string): Result => ({ ok: true, text })
const fail = (text: string): Result => ({ ok: false, text })

export type Activity = { lines: string[]; at: number }

/**
 * The Super-agent's business logic: dispatching, routing, the Worker callbacks,
 * the watchdog and the Router batching. It owns no dsh object; everything
 * reaches dsh through the runtime seam.
 */
export class SuperAgentService {
  private readonly activity = new Map<string, Activity>()
  private readonly idleSince = new Map<string, number>()
  private readonly launching = new Set<number>()
  /** Events the Router already learned from a tool result; the digest skips them. */
  private readonly told = new Set<number>()
  private lastQueuedAt = 0
  private flushing = false
  private projectCache: { at: number; projects: Project[] } | undefined

  constructor(
    readonly board: Board,
    private readonly workers: WorkerRuntime,
    private readonly router: RouterLink,
    private readonly config: ServiceConfig,
    private readonly extraProjects: () => Project[] = () => [],
    private readonly now: () => number = Date.now,
    private readonly lanes: Lanes = new GitLanes(),
  ) {}

  // ── Projects ────────────────────────────────────────────────────────────

  projects(): Project[] {
    const at = this.now()
    if (this.projectCache === undefined || at - this.projectCache.at > 60_000) {
      const scanned = scanRoots(this.config.roots, this.config.scanDepth)
      const seen = new Set(scanned.map(p => p.path))
      const extra = this.extraProjects().filter(p => !seen.has(p.path))
      this.projectCache = { at, projects: [...scanned, ...extra] }
    }
    return this.projectCache.projects
  }

  // ── Router-facing actions ───────────────────────────────────────────────

  async dispatch(input: {
    title: string
    task: string
    project: string
    readonly?: boolean
  }): Promise<Result> {
    const found = resolveProject(input.project, this.projects())
    if (found.kind === 'ambiguous') {
      return fail(
        `项目「${input.project}」有多个匹配：${found.candidates.map(p => p.id).join('、')}。请问用户是哪一个。`,
      )
    }
    if (found.kind === 'none') {
      const hint =
        found.suggestions.length > 0
          ? `相近的有：${found.suggestions.map(p => p.id).join('、')}。`
          : ''
      return fail(
        `没有找到项目「${input.project}」。${hint}请问用户，或调 superagent_projects 查看。`,
      )
    }
    const ticket = await this.board.create({
      title: input.title.trim().slice(0, 60),
      task: input.task,
      executor: 'dsh',
      project: found.project.id,
      projectPath: found.project.path,
      // A writing ticket in an MR project gets its own lane; nothing else does.
      worktree:
        input.readonly !== true &&
        matchDelivery(this.config.projects, this.config.defaultDelivery, found.project.path) ===
          'mr',
      ...(input.readonly === true ? { readonly: true } : {}),
    })
    await this.launchQueued()
    const now = this.board.get(ticket.id) ?? ticket
    if (now.state === 'failed') {
      // The tool result tells the Router; the digest must not tell it again.
      const failed = this.board.eventsOf(now.id).filter(e => e.kind === 'spawn_failed')
      for (const e of failed) this.told.add(e.id)
      return fail(`已开 ${header(now)}，但启动失败：${failed.at(-1)?.body ?? '原因未知'}`)
    }
    const where =
      now.state === 'queued' ? '排队中（同项目已有 Worker 或并发已满）' : STATE_WORDS[now.state]
    const how =
      now.readonly === true ? '，只读' : now.worktree ? '，MR 奏折：在自己的 worktree 里做' : ''
    return ok(`已派 ${header(now)}，${where}${how}。`)
  }

  async message(id: number, text: string): Promise<Result> {
    const t = this.board.get(id)
    if (t === undefined) return fail(`没有奏折 #${id}`)
    if (t.state === 'stopped' || t.state === 'interrupted')
      return fail(`${header(t)} 已${STATE_WORDS[t.state]}，要接着做请用 resume。`)
    if (
      t.state === 'done' &&
      t.endedAt !== undefined &&
      (t.worktree || this.lastKind(id) === 'closed')
    ) {
      return fail(`${header(t)} 已收，不能再发消息；需要的话派一张新奏折。`)
    }
    if (t.sessionId === undefined)
      return fail(`${header(t)} 还没有 Worker（${STATE_WORDS[t.state]}）。`)
    // Deliver first, record after: a ticket must never show working while its
    // Worker got nothing.
    const mode = this.workers.status(t.sessionId) === 'running' ? 'steer' : 'followup'
    if (!(await this.workers.send(t.sessionId, messageText(id, text), mode))) {
      return fail(`没送到 ${header(t)} 的 Worker：会话打不开。`)
    }
    const applied = await this.board.apply(id, 'message', text, 'router')
    if (!applied.ok) return fail(applied.reason)
    return ok(`已转给 ${header(t)}。`)
  }

  async stop(id: number): Promise<Result> {
    const t = this.board.get(id)
    if (t === undefined) return fail(`没有奏折 #${id}`)
    const applied = await this.board.apply(id, 'stop', '', 'you')
    if (!applied.ok) return fail(applied.reason)
    if (t.sessionId !== undefined) await this.workers.cancel(t.sessionId)
    await this.launchQueued()
    return ok(`已停 ${header(t)}。会话保留，可以 resume。`)
  }

  /**
   * An MR ticket ends by its merge; closing one before is giving its change
   * up, so it takes `discard`, the person's confirmation, and removes the lane.
   */
  async close(id: number, discard = false): Promise<Result> {
    const t = this.board.get(id)
    if (t === undefined) return fail(`没有奏折 #${id}`)
    if (t.worktreePath !== undefined && !discard) {
      return fail(
        `${header(t)} 的改动还没合入 main。收 = 放弃这份改动，删掉 worktree 和分支 ${t.branch ?? ''}。先跟用户确认，确认后带 discard=true 再收。`,
      )
    }
    const applied = await this.board.apply(id, 'close', '', 'you')
    if (!applied.ok) return fail(applied.reason)
    if (t.sessionId !== undefined && this.workers.status(t.sessionId) === 'running') {
      await this.workers.cancel(t.sessionId)
    }
    if (t.worktreePath !== undefined) await this.finish(applied.ticket, 'discard')
    await this.launchQueued()
    return ok(
      t.worktreePath !== undefined
        ? `已放弃 ${header(t)}，worktree 和分支已清理。`
        : `已收 ${header(t)}。`,
    )
  }

  /** The board's「放弃」button: close with the person's confirmation. */
  discard(id: number): Promise<Result> {
    return this.close(id, true)
  }

  /** The person approved what an MR ticket's Worker handed back: it opens the MR. */
  async openMr(id: number, note = ''): Promise<Result> {
    const t = this.board.get(id)
    if (t === undefined) return fail(`没有奏折 #${id}`)
    if (t.worktreePath === undefined || t.branch === undefined)
      return fail(`${header(t)} 不是 MR 奏折，没有 MR 可开。`)
    if (t.state !== 'ready' || t.sessionId === undefined)
      return fail(`${header(t)} 处于「${STATE_WORDS[t.state]}」，只有待审的能开 MR。`)
    // Record first, unlike a message: the Worker checks the record
    // (superagent_mr_consent) before it commits, so the yes must be there first.
    const applied = await this.board.apply(id, 'open_mr', '开 MR', 'you')
    if (!applied.ok) return fail(applied.reason)
    await this.board.patch(id, { mrOpened: true })
    if (!(await this.workers.send(t.sessionId, openMrText(id, t.branch, note), 'followup'))) {
      const undone = await this.board.unopenMr(id)
      return fail(
        `没送到 ${header(t)} 的 Worker：会话打不开。` +
          (undone ? '开 MR 已撤回，奏折仍待审。' : '开 MR 已记下，但之后已有新动静，撤不回。'),
      )
    }
    return ok(
      `${header(t)} 开 MR 了：Worker 会 commit、push、开 MR、盯到合入，合入后自动结束并清理。`,
    )
  }

  private laneOf(t: Ticket): Lane | undefined {
    return t.worktreePath !== undefined && t.branch !== undefined
      ? { repo: t.projectPath, path: t.worktreePath, branch: t.branch }
      : undefined
  }

  /**
   * Ends a ticket's lane: the Worker's turn is stopped first (it works in the
   * folder), then the worktree and branch go. One that could not go safely is
   * kept and the person told, with why.
   */
  private async finish(t: Ticket, mode: CleanMode): Promise<void> {
    const lane = this.laneOf(t)
    if (lane === undefined) return
    if (t.sessionId !== undefined && this.workers.status(t.sessionId) === 'running')
      await this.workers.cancel(t.sessionId)
    let cleaned: { removed: boolean; text: string }
    try {
      cleaned = await this.lanes.clean(lane, mode)
    } catch (error) {
      cleaned = { removed: false, text: `保留了 ${lane.path}：${String(error).slice(0, 300)}` }
    }
    if (cleaned.removed)
      await this.board.patch(t.id, { worktreePath: undefined, branch: undefined })
    await this.board.note(t.id, cleaned.removed ? 'cleaned' : 'kept', cleaned.text, 'superagent')
    if (!cleaned.removed) this.queued()
  }

  /** Lanes of ended tickets a cleanup missed (the app quit between a merge and its cleanup). */
  async sweep(): Promise<void> {
    for (const t of this.board.list()) {
      if (t.state !== 'done' || this.laneOf(t) === undefined) continue
      const ended = this.board
        .eventsOf(t.id)
        .findLast(e => e.kind === 'merged' || e.kind === 'closed' || e.kind === 'dropped')
      await this.finish(t, ended?.kind === 'merged' ? 'merged' : 'discard')
    }
  }

  async retry(id: number): Promise<Result> {
    const t = this.board.get(id)
    if (t === undefined) return fail(`没有奏折 #${id}`)
    if (t.state !== 'blocked' && t.state !== 'failed') {
      return fail(`${header(t)} 处于「${STATE_WORDS[t.state]}」，只有受阻或失败的奏折能重试。`)
    }
    if (t.sessionId === undefined || this.board.eventsOf(id).every(e => e.kind !== 'spawned')) {
      const applied = await this.board.apply(id, 'retry', '', 'you')
      if (!applied.ok) return fail(applied.reason)
      await this.launchQueued()
      return ok(`${header(t)} 重新排队。`)
    }
    if (!(await this.workers.send(t.sessionId, RETRY_TEXT(id), 'followup'))) {
      return fail(`没送到 ${header(t)} 的 Worker：会话打不开。`)
    }
    const applied = await this.board.apply(id, 'message', '重试', 'you')
    if (!applied.ok) return fail(applied.reason)
    return ok(`${header(t)} 接着原会话重试。`)
  }

  async resume(id: number): Promise<Result> {
    const t = this.board.get(id)
    if (t === undefined) return fail(`没有奏折 #${id}`)
    if (t.state !== 'stopped' && t.state !== 'interrupted') {
      return fail(`${header(t)} 处于「${STATE_WORDS[t.state]}」，只有已停或中断的奏折能恢复。`)
    }
    if (t.sessionId === undefined) return fail(`${header(t)} 没有可接的会话，请派一张新奏折。`)
    if (!existsSync(t.projectPath)) return fail(`${header(t)} 的目录 ${t.projectPath} 不在了。`)
    const blocker = this.occupant(t)
    if (blocker !== undefined)
      return fail(
        `${t.project} 正被 ${header(blocker)} 占用（${STATE_WORDS[blocker.state]}），收掉它再恢复。`,
      )
    if (this.runningCount() >= this.config.maxConcurrent)
      return fail(`Worker 已满（${this.config.maxConcurrent} 个），等一个结束再恢复。`)
    const applied = await this.board.apply(id, 'resume', '', 'you')
    if (!applied.ok) return fail(applied.reason)
    if (!(await this.workers.send(t.sessionId, RESUME_TEXT(id), 'followup'))) {
      await this.board.apply(id, 'done_failed', '恢复失败：会话打不开', 'superagent')
      return fail(`${header(t)} 恢复失败：会话打不开。`)
    }
    return ok(`${header(t)} 已恢复：Worker 会先自查、汇报，再问你下一步。`)
  }

  list(scope: 'live' | 'all' = 'live'): Ticket[] {
    const all = this.board.list()
    return scope === 'all' ? all : all.filter(t => !ENDED.includes(t.state) || this.recent(t))
  }

  /** Chain of recall: summary → events → the Worker's conversation tail. */
  async read(id: number, depth: 'summary' | 'events' | 'transcript'): Promise<Result> {
    const t = this.board.get(id)
    if (t === undefined) return fail(`没有奏折 #${id}`)
    if (depth === 'summary') {
      const lines = [
        `${header(t)}（${STATE_WORDS[t.state]}）`,
        `目录：${t.worktreePath ?? t.projectPath}${t.branch ? `（worktree，分支 ${t.branch}）` : ''}${t.readonly === true ? '（只读）' : ''}`,
        `任务：${cut(t.task, 1200).text}`,
      ]
      if (t.pending) lines.push(`在等你：${t.pending.summary}`)
      // A pending question is the latest message while it waits: say it once.
      if (t.lastReport && t.lastReport !== t.pending?.summary)
        lines.push(`最近消息：${t.lastReport}`)
      lines.push('更多：depth=events 看事件全文，depth=transcript 看 Worker 会话尾部。')
      return ok(lines.join('\n'))
    }
    if (depth === 'events') {
      const lines = this.board
        .eventsOf(id)
        .map(
          e =>
            `${new Date(e.at).toLocaleString('zh-CN')} ${e.actor} ${e.kind}${e.body ? `：${e.body}` : ''}`,
        )
      return ok(lines.join('\n') || '没有事件。')
    }
    if (t.sessionId === undefined) return fail(`${header(t)} 还没有 Worker 会话。`)
    return ok(await this.workers.transcript(t.sessionId, 6000))
  }

  // ── Worker-facing callbacks ─────────────────────────────────────────────

  async report(sessionId: string, text: string): Promise<Result> {
    const t = this.board.bySession(sessionId)
    if (t === undefined) return fail('这个会话不是 Super-agent 的 Worker。')
    const applied = await this.board.apply(t.id, 'report', text, 'worker')
    return applied.ok ? ok('已汇报。') : fail(applied.reason)
  }

  /** Whether the person's yes to the MR is recorded: never the words in the Session. */
  mrConsent(sessionId: string): Result {
    const t = this.board.bySession(sessionId)
    if (t === undefined) return fail('这个会话不是 Super-agent 的 Worker。')
    return ok(
      mrConsentAnswer(
        { state: t.state, mrOpened: t.mrOpened === true, isMr: t.worktree === true },
        'superagent_done',
      ),
    )
  }

  async done(sessionId: string, outcome: Outcome, text: string): Promise<Result> {
    const t = this.board.bySession(sessionId)
    if (t === undefined) return fail('这个会话不是 Super-agent 的 Worker。')
    if (outcome === 'merged') {
      const refused = await this.whyNotMerged(t)
      if (refused !== undefined) return fail(refused)
    }
    const input: Input = `done_${outcome}`
    const applied = await this.board.apply(t.id, input, text, 'worker')
    if (!applied.ok) return fail(applied.reason)
    this.queued()
    // The lane goes once its work is in main, or once there is no work. After
    // the reply: this call is the Worker's last.
    if (
      applied.ticket.worktreePath !== undefined &&
      (outcome === 'merged' || outcome === 'dropped')
    ) {
      const ended = applied.ticket
      setImmediate(() => {
        void this.finish(ended, outcome === 'merged' ? 'merged' : 'discard').then(() =>
          this.launchQueued(),
        )
      })
    } else if (outcome === 'dropped' || outcome === 'merged') await this.launchQueued()
    return ok('已交回。本轮到此结束，不要再调用工具。')
  }

  /**
   * A merge is checked, not taken on the Worker's word: the MR was asked for,
   * and origin no longer has the branch (the MR deletes it as it merges; a
   * closed MR leaves it). Merges are squashed, so main's history cannot say.
   */
  private async whyNotMerged(t: Ticket): Promise<string | undefined> {
    const lane = this.laneOf(t)
    if (lane === undefined || t.mrOpened !== true)
      return 'merged 只用于用户要求开 MR 之后。没有合入就用 ready / blocked / failed。'
    try {
      if (await this.lanes.hasRemoteBranch(lane))
        return `origin 上还有分支 ${lane.branch}：MR 还没合入，或没有设「合入后删除源分支」。合入（并删掉源分支）后再 done(merged)。`
    } catch (error) {
      return `问不到 origin 上有没有 ${lane.branch}（${String(error).slice(0, 200)}），稍后再试。`
    }
    return undefined
  }

  /** dsh showed a question or an approval request in the Worker's Session. */
  async asked(sessionId: string, kind: 'question' | 'approval', summary: string): Promise<void> {
    const t = this.board.bySession(sessionId)
    if (t === undefined) return
    const applied = await this.board.apply(t.id, 'ask', summary, 'worker', {
      pending: { kind, summary, at: this.now() },
    })
    if (applied.ok) this.queued()
  }

  /** The question or approval was settled (answered, cancelled, or the turn ended). */
  async settled(sessionId: string): Promise<void> {
    const t = this.board.bySession(sessionId)
    if (t === undefined || t.state !== 'asking') return
    await this.board.apply(t.id, 'answered', '', 'you')
  }

  /** The person typed in a Worker's Session. */
  async userSaid(sessionId: string, text: string): Promise<void> {
    const t = this.board.bySession(sessionId)
    if (t === undefined) return
    const applied = await this.board.apply(t.id, 'user_said', text, 'you')
    if (applied.ok) await this.router.note(userSaidNote(applied.ticket, text))
  }

  /** One line of what a Worker just did, for the board's live cards. */
  noteActivity(sessionId: string, line: string): void {
    const prev = this.activity.get(sessionId)?.lines ?? []
    this.activity.set(sessionId, { lines: [...prev, line].slice(-2), at: this.now() })
  }

  activityOf(sessionId: string): Activity | undefined {
    return this.activity.get(sessionId)
  }

  workerStatus(sessionId: string, status: 'idle' | 'running'): void {
    if (status === 'running') this.idleSince.delete(sessionId)
    else if (!this.idleSince.has(sessionId)) this.idleSince.set(sessionId, this.now())
  }

  // ── Watchdog and batching ───────────────────────────────────────────────

  /** Called at plugin start: Workers that were running are no longer. */
  async reconcile(): Promise<void> {
    for (const t of this.board.list()) {
      if (!ACTIVE.includes(t.state) || t.sessionId === undefined) continue
      if (this.workers.status(t.sessionId) !== 'gone') continue
      await this.board.apply(
        t.id,
        'interrupted',
        '应用退出或插件重载时这张奏折正在进行',
        'superagent',
      )
    }
    this.queued()
    await this.sweep()
  }

  /** The program-level watchdog: runs every few seconds. */
  async tick(): Promise<void> {
    const at = this.now()
    for (const t of this.board.list()) {
      if (t.state !== 'working' || t.sessionId === undefined || this.launching.has(t.id)) continue
      const live = this.workers.status(t.sessionId)
      if (live === 'running') {
        this.idleSince.delete(t.sessionId)
        continue
      }
      const since = this.idleSince.get(t.sessionId)
      if (since === undefined) {
        this.idleSince.set(t.sessionId, at)
        continue
      }
      if (at - since < this.config.stallMs) continue
      const last = this.activity.get(t.sessionId)?.lines.at(-1)
      await this.board.apply(
        t.id,
        'stalled',
        `Worker 停下了但没有调用 done。最后的动作：${last ?? '（无记录）'}`,
        'superagent',
      )
      this.idleSince.delete(t.sessionId)
      this.queued()
    }
    await this.launchQueued()
    await this.flush()
  }

  /** Something the Router must hear about was recorded. */
  queued(): void {
    this.lastQueuedAt = this.now()
  }

  /** Hands the Router every waiting event in one message, once it is idle and the burst is over. */
  async flush(): Promise<void> {
    if (this.flushing) return
    const { items, lastId } = this.board.undelivered(this.config.inlineChars, this.told)
    if (items.length === 0) {
      if (lastId > this.board.meta().routerSeenEventId) await this.board.markSeen(lastId)
      return
    }
    if (this.now() - this.lastQueuedAt < this.config.quietMs) return
    if (this.router.status() === 'running') return
    this.flushing = true
    try {
      const meta = this.board.meta()
      const parts = [digest(items)]
      if (meta.overviewDue) parts.unshift(overview(this.board.list()))
      const summary = `${items.length} 条奏折事件`
      if (await this.router.deliver(parts.join('\n\n'), summary)) {
        await this.board.markSeen(lastId)
        if (meta.overviewDue) await this.board.setMeta({ overviewDue: false })
      }
    } finally {
      this.flushing = false
    }
  }

  /** The person spoke to the Router; attach the overview when it is due. */
  async routerHeardUser(): Promise<void> {
    if (!this.board.meta().overviewDue) return
    if (await this.router.note(overview(this.board.list())))
      await this.board.setMeta({ overviewDue: false })
  }

  routerCompacted(): Promise<unknown> {
    return this.board.setMeta({ overviewDue: true })
  }

  // ── Launching ───────────────────────────────────────────────────────────

  private runningCount(): number {
    return this.board.list().filter(t => ACTIVE.includes(t.state) || this.launching.has(t.id))
      .length
  }

  /** The ticket holding the project folder, if any (worktree tickets never block or are blocked). */
  private occupant(t: Ticket): Ticket | undefined {
    if (t.worktree) return undefined
    return this.board
      .list()
      .find(
        o =>
          o.id !== t.id &&
          !o.worktree &&
          o.projectPath === t.projectPath &&
          (OCCUPYING.includes(o.state) || this.launching.has(o.id)),
      )
  }

  async launchQueued(): Promise<void> {
    for (const t of this.board.list()) {
      if (t.state !== 'queued' || this.launching.has(t.id)) continue
      if (this.runningCount() >= this.config.maxConcurrent) return
      if (this.occupant(t) !== undefined) continue
      this.launching.add(t.id)
      try {
        await this.launch(t)
      } finally {
        this.launching.delete(t.id)
      }
    }
  }

  /** Makes an MR ticket's lane (or finds it from a start that failed later); returns its folder. */
  private async enterLane(t: Ticket): Promise<string> {
    const lane = this.laneOf(t) ?? laneFor(t.projectPath, 'superagent', t.id, t.createdAt)
    try {
      await this.lanes.create(lane)
    } catch (error) {
      throw new Error(
        `建 worktree 失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    await this.board.patch(t.id, { worktreePath: lane.path, branch: lane.branch })
    return lane.path
  }

  private async launch(t: Ticket): Promise<void> {
    try {
      if (!existsSync(t.projectPath)) throw new Error(`目录 ${t.projectPath} 不存在`)
      const cwd = t.worktree ? await this.enterLane(t) : t.projectPath
      // The id is fixed before the Session exists, so the creation listener
      // that installs the Worker tools already finds the ticket.
      const sessionId = t.sessionId ?? `session-${randomUUID()}`
      await this.board.patch(t.id, { sessionId })
      await this.workers.create({ sessionId, cwd, preset: this.config.workerPreset })
      if (!(await this.workers.send(sessionId, taskText(t), 'followup')))
        throw new Error('会话建好了，但任务没送进去')
      await this.board.apply(t.id, 'spawn_ok', cwd, 'superagent')
    } catch (error) {
      await this.board.apply(
        t.id,
        'spawn_fail',
        error instanceof Error ? error.message : String(error),
        'superagent',
      )
      this.queued()
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private lastKind(id: number): string | undefined {
    return this.board.eventsOf(id).at(-1)?.kind
  }

  private recent(t: Ticket): boolean {
    return t.endedAt !== undefined && this.now() - t.endedAt < 24 * 3600_000
  }
}
