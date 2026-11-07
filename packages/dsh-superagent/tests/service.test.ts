import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { FakeLanes } from '../../agentd/tests/helpers.js'
import { Board } from '../src/host/board.js'
import type {
  Delivery,
  Liveness,
  RouterLink,
  TranscriptLine,
  WorkerRuntime,
} from '../src/host/runtime.js'
import { DEFAULT_CONFIG, SuperAgentService } from '../src/host/service.js'
import { memoryTables } from '../src/host/tables.js'

class FakeWorkers implements WorkerRuntime {
  sessions = new Map<
    string,
    { cwd: string; status: Liveness; inbox: { text: string; mode: Delivery }[] }
  >()
  unreachable = new Set<string>()
  failCreate = false
  async create({ sessionId, cwd }: { sessionId: string; cwd: string }): Promise<void> {
    if (this.failCreate) throw new Error('boom')
    this.sessions.set(sessionId, { cwd, status: 'running', inbox: [] })
  }
  async send(sessionId: string, text: string, mode: Delivery): Promise<boolean> {
    const s = this.sessions.get(sessionId)
    if (s === undefined || this.unreachable.has(sessionId)) return false
    s.inbox.push({ text, mode })
    s.status = 'running'
    return true
  }
  async cancel(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (s) s.status = 'idle'
  }
  status(sessionId: string): Liveness {
    return this.sessions.get(sessionId)?.status ?? 'gone'
  }
  lines: TranscriptLine[] | undefined = [{ role: 'assistant', text: '做完了' }]
  async transcript(): Promise<TranscriptLine[] | undefined> {
    return this.lines
  }
}

class FakeRouter implements RouterLink {
  live: Liveness = 'idle'
  delivered: string[] = []
  notes: string[] = []
  async ensure(): Promise<string> {
    return 'router-1'
  }
  status(): Liveness {
    return this.live
  }
  async deliver(text: string): Promise<boolean> {
    this.delivered.push(text)
    return true
  }
  async note(text: string): Promise<boolean> {
    this.notes.push(text)
    return true
  }
}

let clock = 0
let alpha: string
let beta: string
let workers: FakeWorkers
let router: FakeRouter
let lanes: FakeLanes
let service: SuperAgentService

/** A service over the two projects; `mr` lists the ones whose delivery is `mr`. */
const make = (mr: string[] = []): SuperAgentService =>
  new SuperAgentService(
    new Board(memoryTables(), () => clock),
    workers,
    router,
    {
      ...DEFAULT_CONFIG,
      roots: [],
      maxConcurrent: 2,
      stallMs: 10_000,
      quietMs: 1_000,
      projects: Object.fromEntries(mr.map(path => [path, { delivery: 'mr' as const }])),
    },
    () => [
      { id: 'alpha', path: alpha, root: alpha },
      { id: 'beta', path: beta, root: beta },
    ],
    () => clock,
    lanes,
  )

const sessionOf = (id: number): string => service.board.get(id)?.sessionId as string

beforeEach(() => {
  clock = 1_000_000
  alpha = mkdtempSync(join(tmpdir(), 'sa-alpha-'))
  beta = mkdtempSync(join(tmpdir(), 'sa-beta-'))
  workers = new FakeWorkers()
  router = new FakeRouter()
  lanes = new FakeLanes()
  service = make()
})

describe('dispatch', () => {
  it('creates the Worker Session under a fixed id and sends the task', async () => {
    const r = await service.dispatch({ title: '修 bug', task: '修掉登录崩溃', project: 'alpha' })
    expect(r.ok).toBe(true)
    const t = service.board.get(1)
    expect(t?.state).toBe('working')
    const s = workers.sessions.get(t?.sessionId as string)
    expect(s?.cwd).toBe(alpha)
    expect(s?.inbox[0]?.text).toContain('【superagent 奏折 #1】修 bug')
    expect(s?.inbox[0]?.mode).toBe('followup')
  })

  it('queues a second non-worktree ticket on the same project until the first is closed', async () => {
    await service.dispatch({ title: 'a', task: 'a', project: 'alpha' })
    await service.dispatch({ title: 'b', task: 'b', project: 'alpha' })
    expect(service.board.get(2)?.state).toBe('queued')
    await service.done(sessionOf(1), 'ready', '好了')
    expect(service.board.get(2)?.state).toBe('queued') // ready still holds the folder
    await service.close(1)
    expect(service.board.get(2)?.state).toBe('working')
  })

  it('caps concurrent Workers', async () => {
    service = make([alpha])
    for (const title of ['a', 'b', 'c'])
      await service.dispatch({ title, task: title, project: 'alpha' })
    expect(service.board.get(2)?.state).toBe('working')
    expect(service.board.get(3)?.state).toBe('queued')
  })

  it('refuses an unknown project without opening a ticket', async () => {
    const r = await service.dispatch({ title: 'x', task: 'x', project: 'nowhere' })
    expect(r.ok).toBe(false)
    expect(service.board.list()).toHaveLength(0)
  })

  it('marks the ticket failed when the Session cannot be created, and tells the Router once', async () => {
    workers.failCreate = true
    const r = await service.dispatch({ title: 'a', task: 'a', project: 'alpha' })
    expect(r.ok).toBe(false)
    expect(r.text).toContain('启动失败')
    expect(service.board.get(1)?.state).toBe('failed')
    clock += 5_000
    await service.flush()
    expect(router.delivered).toHaveLength(0) // the tool result already said so
  })
})

describe('routing', () => {
  beforeEach(async () => {
    await service.dispatch({ title: 'a', task: 'a', project: 'alpha' })
  })

  it('steers a running Worker and records only after delivery', async () => {
    expect((await service.message(1, '顺便加测试')).ok).toBe(true)
    const inbox = workers.sessions.get(sessionOf(1))?.inbox
    expect(inbox?.at(-1)).toEqual({
      text: '【superagent 奏折 #1 追加指令】顺便加测试',
      mode: 'steer',
    })
    workers.unreachable.add(sessionOf(1))
    await service.done(sessionOf(1), 'ready', '好了')
    const r = await service.message(1, '再改一下')
    expect(r.ok).toBe(false)
    expect(service.board.get(1)?.state).toBe('ready')
  })

  it('refuses messages to a closed ticket but reopens a dropped one', async () => {
    await service.done(sessionOf(1), 'dropped', '无事可做')
    expect((await service.message(1, '再看看')).ok).toBe(true)
    expect(service.board.get(1)?.state).toBe('working')
    await service.close(1)
    expect((await service.message(1, '还有')).ok).toBe(false)
  })

  it('mirrors a question and its answer', async () => {
    await service.asked(sessionOf(1), 'question', '用方案 A 还是 B？')
    expect(service.board.get(1)?.state).toBe('asking')
    expect(service.board.get(1)?.pending?.summary).toBe('用方案 A 还是 B？')
    await service.settled(sessionOf(1))
    expect(service.board.get(1)?.state).toBe('working')
    expect(service.board.get(1)?.pending).toBeUndefined()
  })

  it('keeps the latest message, a question included, and read says it once', async () => {
    const last = (): string | undefined => service.board.get(1)?.lastReport
    const summary = async (): Promise<string> => (await service.read(1, 'summary')).text
    await service.report(sessionOf(1), '定位到根因')
    await service.asked(sessionOf(1), 'approval', '要运行 rm -rf dist')
    expect(last()).toBe('要运行 rm -rf dist')
    expect(await summary()).toContain('在等你：要运行 rm -rf dist')
    expect(await summary()).not.toContain('最近消息')
    // The person's own words are not the ticket's latest message.
    await service.settled(sessionOf(1))
    await service.userSaid(sessionOf(1), '批准')
    expect(last()).toBe('要运行 rm -rf dist')
    await service.report(sessionOf(1), '改完一处')
    expect(await summary()).toContain('最近消息：改完一处')
    expect(await summary()).not.toContain('最近汇报')
  })

  it('tells the Router quietly when the person speaks in a Worker Session', async () => {
    await service.userSaid(sessionOf(1), '直接用方案 B')
    expect(router.notes.at(-1)).toContain('用户在 #1 · alpha · a 的会话里说：直接用方案 B')
  })
})

describe('batching to the Router', () => {
  beforeEach(async () => {
    await service.dispatch({ title: 'a', task: 'a', project: 'alpha' })
    await service.dispatch({ title: 'b', task: 'b', project: 'beta' })
  })

  it('waits for the burst to end, then delivers all events in one message with the overview', async () => {
    await service.report(sessionOf(1), '找到根因了')
    await service.asked(sessionOf(1), 'question', '要不要改接口？')
    await service.done(sessionOf(2), 'ready', '改完了，测试通过')
    await service.flush()
    expect(router.delivered).toHaveLength(0) // burst not over
    clock += 1_500
    await service.flush()
    expect(router.delivered).toHaveLength(1)
    const text = router.delivered[0] as string
    expect(text).toContain('当前奏折总览')
    expect(text).toContain('[superagent] 2 条新事件')
    expect(text).toContain('此前进展：找到根因了')
    clock += 5_000
    await service.flush()
    expect(router.delivered).toHaveLength(1) // nothing new
  })

  it('holds events while the Router is mid-turn', async () => {
    await service.done(sessionOf(1), 'blocked', '缺权限')
    clock += 5_000
    router.live = 'running'
    await service.flush()
    expect(router.delivered).toHaveLength(0)
    router.live = 'idle'
    await service.flush()
    expect(router.delivered).toHaveLength(1)
    expect(router.delivered[0]).toContain('缺权限')
  })

  it('re-sends the overview after the Router is compacted', async () => {
    await service.done(sessionOf(1), 'ready', '好了')
    clock += 5_000
    await service.flush()
    await service.routerCompacted()
    await service.done(sessionOf(2), 'ready', '好了')
    clock += 5_000
    await service.flush()
    expect(router.delivered[1]).toContain('当前奏折总览')
  })
})

describe('watchdog', () => {
  beforeEach(async () => {
    await service.dispatch({ title: 'a', task: 'a', project: 'alpha' })
  })

  it('marks a Worker that went idle without done as stalled, after the grace period', async () => {
    const s = workers.sessions.get(sessionOf(1))
    if (s) s.status = 'idle'
    service.noteActivity(sessionOf(1), '▸ bash pnpm test')
    await service.tick()
    expect(service.board.get(1)?.state).toBe('working')
    clock += 11_000
    await service.tick()
    expect(service.board.get(1)?.state).toBe('blocked')
    expect(service.board.eventsOf(1).at(-1)?.body).toContain('▸ bash pnpm test')
  })

  it('marks running tickets interrupted at start when their Session is gone, and resumes them', async () => {
    workers.sessions.delete(sessionOf(1))
    await service.reconcile()
    expect(service.board.get(1)?.state).toBe('interrupted')
    expect((await service.resume(1)).ok).toBe(false) // the Session cannot be reached
    expect(service.board.get(1)?.state).toBe('failed')
  })

  it('resumes an interrupted ticket with the read-only self-check text', async () => {
    const s = workers.sessions.get(sessionOf(1))
    if (s) s.status = 'gone'
    workers.sessions.delete(sessionOf(1))
    await service.reconcile()
    workers.sessions.set(sessionOf(1), { cwd: alpha, status: 'idle', inbox: [] })
    expect((await service.resume(1)).ok).toBe(true)
    expect(service.board.get(1)?.state).toBe('working')
    expect(workers.sessions.get(sessionOf(1))?.inbox.at(-1)?.text).toContain('只读自查')
  })

  it('does not resume into a folder another ticket holds', async () => {
    await service.stop(1)
    await service.dispatch({ title: 'b', task: 'b', project: 'alpha' })
    expect(service.board.get(2)?.state).toBe('working')
    const r = await service.resume(1)
    expect(r.ok).toBe(false)
    expect(r.text).toContain('正被 #2')
  })
})

describe('MR tickets', () => {
  /** An alpha ticket handed back ready, in its lane. */
  const handedBack = async () => {
    service = make([alpha])
    await service.dispatch({ title: '改', task: '改', project: 'alpha' })
    await service.done(sessionOf(1), 'ready', '改好了')
    return service.board.get(1)!
  }

  it('writing tickets of an MR project each get a lane and run side by side', async () => {
    service = make([alpha])
    await service.dispatch({ title: 'a', task: 'a', project: 'alpha' })
    await service.dispatch({ title: 'b', task: 'b', project: 'alpha' })
    const [a, b] = [service.board.get(1)!, service.board.get(2)!]
    expect([a.state, b.state]).toEqual(['working', 'working'])
    expect(a.branch).toMatch(/^superagent\/1-[0-9a-z]+$/)
    expect(a.worktreePath).toBe(join(alpha, '.claude', 'worktrees', a.branch!.replace('/', '-')))
    expect(workers.sessions.get(sessionOf(2))?.cwd).toBe(b.worktreePath)
    expect(lanes.created).toHaveLength(2)
  })

  it('a lane that cannot be made fails the start with why', async () => {
    service = make([alpha])
    lanes.failCreate = 'fetch 失败'
    await service.dispatch({ title: 'a', task: 'a', project: 'alpha' })
    expect(service.board.get(1)?.state).toBe('failed')
    expect(service.board.eventsOf(1).at(-1)?.body).toContain('建 worktree 失败')
  })

  it('open MR → merged: told to the Worker, checked against origin, then the lane goes', async () => {
    const t = await handedBack()
    expect((await service.done(t.sessionId!, 'merged', 'x')).ok).toBe(false)
    expect((await service.openMr(1)).ok).toBe(true)
    expect(workers.sessions.get(t.sessionId!)?.inbox.at(-1)?.text).toContain('【奏折 #1 开 MR】')
    expect(service.board.get(1)).toMatchObject({ state: 'working', mrOpened: true })
    lanes.remote.add(t.branch!)
    const early = await service.done(t.sessionId!, 'merged', 'MR !3')
    expect(early.ok ? '' : early.text).toContain('还有分支')
    lanes.remote.delete(t.branch!)
    expect((await service.done(t.sessionId!, 'merged', 'MR !3 已合入')).ok).toBe(true)
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
    expect(lanes.cleaned).toMatchObject([{ lane: { branch: t.branch }, mode: 'merged' }])
    expect(service.board.get(1)).toMatchObject({ state: 'done' })
    expect(service.board.get(1)?.worktreePath).toBeUndefined()
    expect((await service.message(1, '再改')).ok).toBe(false)
  })

  it('closing one before its merge needs discard, and removes the lane', async () => {
    await handedBack()
    const refused = await service.close(1)
    expect(refused.ok ? '' : refused.text).toContain('discard')
    expect((await service.discard(1)).ok).toBe(true)
    expect(lanes.cleaned.map(c => c.mode)).toEqual(['discard'])
    expect(service.board.eventsOf(1).at(-1)?.kind).toBe('cleaned')
  })

  it('what the person said with their yes rides on 开 MR', async () => {
    const t = await handedBack()
    expect((await service.openMr(1, '先在 k8s-0 验证')).ok).toBe(true)
    const text = workers.sessions.get(t.sessionId!)?.inbox.at(-1)?.text
    expect(text).toContain('【奏折 #1 开 MR】')
    expect(text).toContain('用户另外交代：先在 k8s-0 验证')
    expect(service.board.get(1)).toMatchObject({ state: 'working', mrOpened: true })
  })

  it('an undelivered 开 MR is taken back: ready again, as if never asked', async () => {
    const t = await handedBack()
    const before = service.board.eventsOf(1).map(e => e.kind)
    workers.unreachable.add(t.sessionId!)
    const r = await service.openMr(1)
    expect(r.ok ? '' : r.text).toContain('开 MR 已撤回')
    expect(service.board.get(1)?.state).toBe('ready')
    expect(service.board.get(1)?.mrOpened).toBeUndefined()
    expect(service.board.eventsOf(1).map(e => e.kind)).toEqual(before)
  })

  it('the Worker checks the yes against the record, which is there before the words arrive', async () => {
    const t = await handedBack()
    // Words typed into the Worker's Session record nothing.
    expect(service.mrConsent(t.sessionId!).text).toContain('没有记下')
    let seen = ''
    const send = workers.send.bind(workers)
    workers.send = async (id, text, mode) => {
      seen = service.mrConsent(id).text
      return send(id, text, mode)
    }
    expect((await service.openMr(1)).ok).toBe(true)
    expect(seen).toContain('已记下')
  })

  it('a lane missed by a cleanup is swept when the plugin starts', async () => {
    const t = await handedBack()
    await service.openMr(1)
    lanes.keep = true
    await service.done(t.sessionId!, 'merged', '已合入')
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
    expect(service.board.eventsOf(1).at(-1)?.kind).toBe('kept')
    lanes.keep = false
    await service.reconcile()
    expect(service.board.get(1)?.worktreePath).toBeUndefined()
  })
})

describe('readonly tickets', () => {
  it('are told to only look, get no lane, and (unenforced in dsh) still hold a local project', async () => {
    service = make([alpha])
    await service.dispatch({ title: '查', task: '查', project: 'alpha', readonly: true })
    expect(lanes.created).toEqual([])
    expect(service.board.get(1)).toMatchObject({ readonly: true, worktree: false })
    expect(workers.sessions.get(sessionOf(1))?.cwd).toBe(alpha)
    await service.dispatch({ title: '查', task: '查', project: 'beta', readonly: true })
    await service.dispatch({ title: '改', task: '改', project: 'beta' })
    expect(service.board.get(3)?.state).toBe('queued')
  })
})

describe('chain of recall', () => {
  it('a follow-up links both ways, and a follows naming no ticket is dropped with a word', async () => {
    await service.dispatch({ title: '修登录', task: '登录重试改退避', project: 'alpha' })
    await service.close(1)
    const next = await service.dispatch({
      title: '修登录第二轮',
      task: '接着改',
      project: 'alpha',
      follows: 1,
    })
    expect(next.text).not.toContain('没记接续关系')
    expect(service.board.get(2)?.follows).toBe(1)
    const slip = await service.dispatch({ title: '别的', task: 'p', project: 'beta', follows: 99 })
    expect(slip).toMatchObject({ ok: true })
    expect(slip.text).toContain('没有奏折 #99，没记接续关系')
    expect(service.board.get(3)?.follows).toBeUndefined()

    expect((await service.read(2, 'summary')).text).toContain(
      '接续自：#1 · alpha · 修登录（已结束）',
    )
    expect((await service.read(1, 'summary')).text).toContain('后续：#2 · alpha · 修登录第二轮（')
    expect((await service.read(3, 'summary')).text).not.toMatch(/接续自|后续/)
  })

  it('find searches ended tickets too, by word and project, newest first', async () => {
    await service.dispatch({ title: '修登录', task: 'a', project: 'alpha' })
    await service.dispatch({ title: '加导出', task: '导出 CSV', project: 'beta' })
    await service.report(sessionOf(2), '顺手把登录页按钮也改了')
    await service.close(1)
    expect(service.find({ query: '登录' }).map(t => t.id)).toEqual([2, 1])
    expect(service.find({ query: 'csv' }).map(t => t.id)).toEqual([2])
    expect(service.find({ query: '登录', project: 'ALP' }).map(t => t.id)).toEqual([1])
    expect(service.find({ query: '登录', limit: 1 }).map(t => t.id)).toEqual([2])
  })

  it('a long task is cut in summary with the way to the whole', async () => {
    const long = '把登录重试改成指数退避。'.repeat(150)
    await service.dispatch({ title: 't', task: long, project: 'alpha' })
    const summary = (await service.read(1, 'summary')).text
    expect(summary).toContain(
      `（共 ${long.length} 字，已截断，superagent_read id=1 depth=task 取全文）`,
    )
    expect(summary).not.toContain(long)
    expect((await service.read(1, 'task')).text).toBe(long)
  })

  it('events page back from before an event id', async () => {
    await service.dispatch({ title: 't', task: 'p', project: 'alpha' })
    for (const text of ['一', '二', '三']) await service.report(sessionOf(1), text)
    const last = (await service.read(1, 'events', { limit: 2 })).text.split('\n')
    const before = Number(/before=(\d+)/.exec(last[0] ?? '')?.[1])
    expect(last[0]).toBe(`（更早还有：superagent_read id=1 depth=events before=${before}）`)
    expect(last.slice(1).map(l => l.split('：').at(-1))).toEqual(['二', '三'])
    const older = (await service.read(1, 'events', { before })).text
    expect(older).not.toContain('更早还有')
    expect(older).toContain('dispatched')
    expect(older).not.toContain('：二')
  })

  it('a transcript pages back by line, and a cut line reads whole by its row', async () => {
    await service.dispatch({ title: 't', task: 'p', project: 'alpha' })
    const long = '长'.repeat(700)
    workers.lines = [
      ...Array.from({ length: 5 }, (_, i) => ({ role: 'user', text: `第 ${i} 句` })),
      { role: 'assistant', text: long },
    ]
    const tail = (await service.read(1, 'transcript', { limit: 3 })).text.split('\n')
    expect(tail[0]).toBe('（更早还有：superagent_read id=1 depth=transcript before=3）')
    expect(tail.at(-1)).toBe(
      `assistant: ${'长'.repeat(600)}…（已截断，superagent_read id=1 depth=transcript row=5 取全文）`,
    )
    expect((await service.read(1, 'transcript', { row: 5 })).text).toBe(`assistant: ${long}`)
    expect((await service.read(1, 'transcript', { row: 9 })).ok).toBe(false)
    const older = (await service.read(1, 'transcript', { before: 3, limit: 3 })).text
    expect(older).toBe('user: 第 0 句\nuser: 第 1 句\nuser: 第 2 句')
    workers.lines = undefined
    expect((await service.read(1, 'transcript')).ok).toBe(false)
  })
})
