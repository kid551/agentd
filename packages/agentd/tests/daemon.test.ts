import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { settle, world } from './helpers.js'

describe('dispatch', () => {
  test('resolves the project, queues, then launches a Worker with its MCP config', async () => {
    const { daemon, runtime, store } = world()
    const r = daemon.dispatch({ project: 'memos', title: '加个搜索', prompt: '给列表加搜索框' })
    expect(r.ok).toBe(true)
    await settle(daemon)
    expect(runtime.spawns).toHaveLength(1)
    const spec = runtime.spawns[0]!
    expect(spec).toMatchObject({ name: 'agentd-w-1', model: 'opus', permissionMode: 'auto' })
    expect(spec.taskPrompt).toContain('【agentd ticket #1】加个搜索')
    expect(spec.systemPrompt).toContain('mcp__agentd__ask')
    const mcp = JSON.parse(readFileSync(spec.mcpConfigPath, 'utf8'))
    expect(mcp.mcpServers.agentd.env).toEqual({
      AGENTD_URL: 'http://127.0.0.1:7707',
      AGENTD_TICKET: '1',
    })
    expect(store.ticket(1)).toMatchObject({ state: 'working', workerBgId: 'bg11' })
  })

  test('an unknown or ambiguous project is refused with candidates, and no ticket is made', () => {
    const { daemon, store } = world()
    const r = daemon.dispatch({ project: 'nope', title: 't', prompt: 'p' })
    expect(r.ok).toBe(false)
    expect(store.listTickets('all')).toHaveLength(0)
  })

  test('a model given for one ticket reaches its Worker', async () => {
    const { daemon, runtime } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p', model: 'sonnet' })
    await settle(daemon)
    expect(runtime.spawns[0]).toMatchObject({ model: 'sonnet' })
  })
})

describe('the queue', () => {
  test('one writing Worker per local project; a readonly one neither holds nor waits', async () => {
    const { daemon, runtime, store } = world()
    daemon.dispatch({ project: 'memos', title: 'a', prompt: 'p' })
    daemon.dispatch({ project: 'memos', title: 'b', prompt: 'p' })
    daemon.dispatch({ project: 'memos', title: 'c', prompt: 'p', readonly: true })
    daemon.dispatch({ project: 'acme', title: 'd', prompt: 'p' })
    await settle(daemon)
    expect(runtime.spawns.map(s => s.name)).toEqual(['agentd-w-1', 'agentd-w-3', 'agentd-w-4'])
    expect(store.ticket(2)?.state).toBe('queued')
    // A handoff keeps the project: its Worker is still there, its work uncommitted.
    daemon.done(1, 'ready', '好了')
    await settle(daemon)
    expect(store.ticket(2)?.state).toBe('queued')
    // Accepting it frees the project for the next ticket.
    await daemon.close(1)
    await settle(daemon)
    expect(runtime.spawns.map(s => s.name)).toContain('agentd-w-2')
  })

  test('a ticket whose Worker never started does not hold its project', async () => {
    const { daemon, runtime, store } = world()
    runtime.next = () => ({ ok: false, reason: 'no', isUntrusted: false })
    daemon.dispatch({ project: 'memos', title: 'a', prompt: 'p' })
    await settle(daemon)
    expect(store.ticket(1)?.state).toBe('failed')
    runtime.next = () => ({ ok: true, bgId: 'bgok' })
    daemon.dispatch({ project: 'memos', title: 'b', prompt: 'p' })
    await settle(daemon)
    expect(store.ticket(2)?.state).toBe('working')
  })

  test('never more Workers than maxConcurrent', async () => {
    const { daemon, runtime } = world({
      worker: { model: 'opus', permissionMode: 'auto', maxConcurrent: 2 },
    })
    for (const project of ['memos', 'acme', 'billboard'])
      daemon.dispatch({ project, title: 't', prompt: 'p' })
    await settle(daemon)
    expect(runtime.spawns).toHaveLength(2)
  })

  test('a launch that fails fails the ticket with the reason; retry queues it again', async () => {
    const { daemon, runtime, store } = world()
    runtime.next = spec => ({
      ok: false,
      reason: `${spec.cwd} 尚未被 Claude Code 信任`,
      isUntrusted: true,
    })
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    expect(store.ticket(1)).toMatchObject({ state: 'failed', needsMe: true })
    expect(store.ticket(1)?.lastReport).toBeNull()
    expect(store.eventsOf(1).at(-1)).toMatchObject({ kind: 'spawn_failed' })
    runtime.next = () => ({ ok: true, bgId: 'bgok' })
    expect((await daemon.retry(1)).ok).toBe(true)
    await settle(daemon)
    expect(store.ticket(1)).toMatchObject({ state: 'working', workerBgId: 'bgok' })
  })

  test('every Worker gets the permission hooks in its settings', async () => {
    const { daemon, runtime } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    const hooks = JSON.parse(runtime.spawns[0]!.settings as string).hooks
    expect(Object.keys(hooks)).toEqual(['PermissionDenied', 'PermissionRequest', 'PreToolUse'])
    expect(hooks.PermissionDenied[0].hooks[0].command).toContain('AGENTD_TICKET=1')
    expect(hooks.PreToolUse[0].hooks[0].command).toMatch(/^if \[ -e '.*\/mcp\/1\.grant' \]/)
  })

  test('retry on a blocked ticket with a Worker resumes its conversation with the hooks', async () => {
    const { daemon, runtime, store } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    await settle(daemon)
    daemon.done(1, 'blocked', 'git commit 被拒')
    runtime.next = () => ({ ok: true, bgId: 'bgnew' })
    const r = await daemon.retry(1)
    expect(r.ok).toBe(true)
    expect(runtime.stops).toEqual(['bg11'])
    const spec = runtime.spawns[1]!
    expect(spec).toMatchObject({ resume: 'sess-agentd-w-1', name: 'agentd-w-1' })
    expect(spec.settings).toContain('PermissionDenied')
    expect(spec.taskPrompt).toContain('重启')
    expect(store.ticket(1)).toMatchObject({ state: 'working', workerBgId: 'bgnew' })
  })

  test('retry on a working ticket with a Worker is refused', async () => {
    const { daemon, runtime } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    await settle(daemon)
    expect((await daemon.retry(1)).ok).toBe(false)
    expect(runtime.spawns).toHaveLength(1)
  })

  test("the person's words to a blocked Worker resume its conversation as a user turn", async () => {
    const { daemon, runtime, store } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    await settle(daemon)
    daemon.done(1, 'blocked', 'git commit 被拒')
    runtime.next = () => ({ ok: true, bgId: 'bgnew' })
    const r = await daemon.say(1, '批准提交并开 MR')
    expect(r.ok).toBe(true)
    expect(runtime.stops).toEqual(['bg11'])
    const spec = runtime.spawns[1]!
    expect(spec).toMatchObject({ resume: 'sess-agentd-w-1' })
    expect(spec.taskPrompt).toContain('用户本人')
    expect(spec.taskPrompt).toMatch(/批准提交并开 MR$/)
    expect(store.ticket(1)).toMatchObject({ state: 'working', workerBgId: 'bgnew' })
    expect(store.eventsOf(1, 1)[0]).toMatchObject({ kind: 'message', actor: 'you' })
  })

  test('say to a Worker that is still working is refused, so its turn is not cut', async () => {
    const { daemon, runtime } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    await settle(daemon)
    expect((await daemon.say(1, '批准')).ok).toBe(false)
    expect(runtime.stops).toEqual([])
  })
})

describe('resume', () => {
  /** A Worker that ran (so it has a conversation), then the person stopped it. */
  const stopped = async (config: Parameters<typeof world>[0] = {}) => {
    const w = world(config)
    w.daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(w.daemon)
    await settle(w.daemon)
    await w.daemon.stop(1)
    return w
  }

  test('a stopped ticket resumes its conversation, told to look and ask before it acts', async () => {
    const { daemon, runtime, store } = await stopped()
    runtime.next = () => ({ ok: true, bgId: 'bgnew' })
    const r = await daemon.resume(1)
    expect(r.ok).toBe(true)
    const spec = runtime.spawns[1]!
    expect(spec).toMatchObject({ resume: 'sess-agentd-w-1', name: 'agentd-w-1' })
    expect(spec.settings).toContain('PermissionDenied')
    expect(spec.taskPrompt).toContain('用户中途停止过你')
    expect(spec.taskPrompt).toContain('得到回答之前不做任何写操作')
    expect(store.ticket(1)).toMatchObject({ state: 'working', workerBgId: 'bgnew', endedAt: null })
    expect(store.eventsOf(1, 1)[0]).toMatchObject({ kind: 'resumed', actor: 'you' })
  })

  test('resume is only for stopped tickets; retry keeps blocked and failed', async () => {
    const { daemon, runtime } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    await settle(daemon)
    daemon.done(1, 'blocked', '被拒')
    const r = await daemon.resume(1)
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('用 retry') })
    expect(runtime.spawns).toHaveLength(1)
  })

  test('a ticket stopped before its Worker started has nothing to resume', async () => {
    const { daemon, runtime } = world({
      worker: { model: 'opus', permissionMode: 'auto', maxConcurrent: 0 },
    })
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await daemon.stop(1)
    expect(await daemon.resume(1)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('没有会话可恢复'),
    })
    expect(runtime.spawns).toHaveLength(0)
  })

  test('resume waits for its project: another ticket working there refuses it', async () => {
    const { daemon, runtime } = await stopped()
    daemon.dispatch({ project: 'memos', title: 'b', prompt: 'p' })
    await settle(daemon)
    expect(runtime.spawns.map(s => s.name)).toEqual(['agentd-w-1', 'agentd-w-2'])
    expect(await daemon.resume(1)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('正被 #2 占用'),
    })
    expect(runtime.spawns).toHaveLength(2)
  })

  test('resume respects maxConcurrent', async () => {
    const { daemon, runtime } = await stopped({
      worker: { model: 'opus', permissionMode: 'auto', maxConcurrent: 1 },
    })
    daemon.dispatch({ project: 'acme', title: 'b', prompt: 'p' })
    await settle(daemon)
    expect(await daemon.resume(1)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Worker 已满'),
    })
    expect(runtime.spawns).toHaveLength(2)
  })

  test('a folder that is gone is refused, not relaunched into nothing', async () => {
    const { daemon, runtime, store } = await stopped()
    store.setWorker(1, { cwd: '/nowhere/agentd-1' })
    expect(await daemon.resume(1)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('已不存在'),
    })
    expect(runtime.spawns).toHaveLength(1)
  })

  test('retry on a stopped or closed ticket says what to do instead', async () => {
    const { daemon } = await stopped()
    expect(await daemon.retry(1)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('resume'),
    })
    daemon.dispatch({ project: 'acme', title: 'b', prompt: 'p' })
    await settle(daemon)
    await settle(daemon)
    daemon.done(2, 'ready', '好了')
    await daemon.close(2)
    expect(await daemon.retry(2)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('派新 ticket'),
    })
  })

  test('a queued ticket does not launch into the project of one being resumed', async () => {
    const { daemon, runtime, store } = await stopped()
    let release: () => void = () => {}
    const spawn = runtime.spawn.bind(runtime)
    runtime.spawn = async spec => {
      if (spec.resume) await new Promise<void>(r => (release = r))
      return spawn(spec)
    }
    const resuming = daemon.resume(1)
    daemon.dispatch({ project: 'memos', title: 'b', prompt: 'p' })
    await settle(daemon)
    expect(store.ticket(2)?.state).toBe('queued')
    release()
    expect((await resuming).ok).toBe(true)
  })
})

describe('permission grants', () => {
  const ask = async () => {
    const w = world()
    w.daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(w.daemon)
    const asked = w.daemon.ask(1, '权限请求', ['批准', '拒绝'], {
      grantKey: 'Bash {"command":"x"}',
    })
    expect(asked.ok).toBe(true)
    return w
  }
  const flag = (w: Awaited<ReturnType<typeof ask>>) => join(w.root, '..', 'mcp', '1.grant')

  test('an approval grants exactly one retry of that call, and the flag file follows', async () => {
    const w = await ask()
    expect(w.store.ticket(1)?.openQuestion).toMatchObject({ kind: 'permission' })
    expect(w.daemon.answer(1, '批准').ok).toBe(true)
    expect(existsSync(flag(w))).toBe(true)
    expect(w.daemon.takeGrant(1, 'Bash {"command":"y"}')).toBe(false)
    expect(w.daemon.takeGrant(1, 'Bash {"command":"x"}')).toBe(true)
    expect(w.daemon.takeGrant(1, 'Bash {"command":"x"}')).toBe(false)
    expect(existsSync(flag(w))).toBe(false)
  })

  test('a rejection grants nothing', async () => {
    const w = await ask()
    w.daemon.answer(1, '拒绝')
    expect(w.daemon.takeGrant(1, 'Bash {"command":"x"}')).toBe(false)
    expect(existsSync(flag(w))).toBe(false)
  })

  test('a grant not used within its time expires', async () => {
    const w = await ask()
    w.daemon.answer(1, '批准')
    w.clock.now += 11 * 60_000
    expect(w.daemon.takeGrant(1, 'Bash {"command":"x"}')).toBe(false)
    expect(existsSync(flag(w))).toBe(false)
  })

  test('a plain question never grants, whatever the answer', async () => {
    const w = world()
    w.daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(w.daemon)
    w.daemon.ask(1, '用哪个方案？', null)
    expect(w.store.ticket(1)?.openQuestion).toMatchObject({ kind: 'ask' })
    w.daemon.answer(1, '批准')
    expect(existsSync(flag(w))).toBe(false)
  })
})

describe('following Workers', () => {
  test('activity shows the last lines of each working Worker, and none for others', async () => {
    const config = mkdtempSync(join(tmpdir(), 'agentd-cfg-'))
    mkdirSync(join(config, 'projects', '-r-memos'), { recursive: true })
    const line = {
      type: 'assistant',
      timestamp: '2026-11-04T01:00:00.000Z',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/r/a.ts' } }] },
    }
    writeFileSync(
      join(config, 'projects', '-r-memos', 'sess-agentd-w-1.jsonl'),
      `${JSON.stringify(line)}\n`,
    )
    vi.stubEnv('CLAUDE_CONFIG_DIR', config)
    try {
      const { daemon, store } = world()
      daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
      await settle(daemon)
      await settle(daemon)
      expect(daemon.activity()).toEqual([
        { ticketId: 1, lines: ['▸ Read /r/a.ts'], at: Date.parse(line.timestamp) },
      ])
      daemon.ask(1, '哪个？', null)
      expect(store.ticket(1)?.state).toBe('asking')
      expect(daemon.activity()).toEqual([])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  test('records the session id and cwd the Worker list reports', async () => {
    const { daemon, runtime, store } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    runtime.set('agentd-w-1', { cwd: '/wt/agentd-1' })
    await settle(daemon)
    expect(store.ticket(1)).toMatchObject({
      workerSessionId: 'sess-agentd-w-1',
      cwd: '/wt/agentd-1',
    })
  })

  test('a Worker idle in working past the stall limit makes the ticket blocked', async () => {
    const { daemon, runtime, store, clock } = world({ stallSeconds: 45 })
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    runtime.set('agentd-w-1', { status: 'idle' })
    await settle(daemon)
    clock.now += 44_000
    await settle(daemon)
    expect(store.ticket(1)?.state).toBe('working')
    clock.now += 2_000
    await settle(daemon)
    expect(store.ticket(1)).toMatchObject({ state: 'blocked' })
    expect(store.eventsOf(1).at(-1)?.kind).toBe('stalled')
  })

  test('a busy spell resets the stall clock', async () => {
    const { daemon, runtime, store, clock } = world({ stallSeconds: 45 })
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    runtime.set('agentd-w-1', { status: 'idle' })
    await settle(daemon)
    clock.now += 30_000
    runtime.set('agentd-w-1', { status: 'busy' })
    await settle(daemon)
    runtime.set('agentd-w-1', { status: 'idle' })
    clock.now += 30_000
    await settle(daemon)
    expect(store.ticket(1)?.state).toBe('working')
  })

  test('a Worker that vanished without done fails its ticket', async () => {
    const { daemon, runtime, store, clock } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    runtime.workers = []
    await settle(daemon)
    expect(store.ticket(1)?.state).toBe('working')
    clock.now += 21_000
    await settle(daemon)
    expect(store.ticket(1)).toMatchObject({ state: 'failed' })
    expect(store.eventsOf(1).at(-1)?.kind).toBe('exited')
  })

  test('a Worker still listed but without a pid has exited; one idle with state "done" has not', async () => {
    const { daemon, runtime, store, clock } = world()
    daemon.dispatch({ project: 'memos', title: 'a', prompt: 'p' })
    daemon.dispatch({ project: 'acme', title: 'b', prompt: 'p' })
    await settle(daemon)
    runtime.set('agentd-w-1', { pid: undefined, state: 'done' })
    runtime.set('agentd-w-2', { status: 'idle', state: 'done' })
    clock.now += 21_000
    await settle(daemon)
    expect(store.eventsOf(1).at(-1)?.kind).toBe('exited')
    expect(store.ticket(2)?.state).toBe('working')
  })

  test('stop stops the Worker process', async () => {
    const { daemon, runtime, store } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    await daemon.stop(1)
    expect(runtime.stops).toEqual(['bg11'])
    expect(store.ticket(1)?.state).toBe('stopped')
  })

  test('closing a ticket stops its Worker; a message can no longer reopen it', async () => {
    const { daemon, runtime, store } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    daemon.done(1, 'ready', '改完了')
    expect((await daemon.close(1)).ok).toBe(true)
    expect(runtime.stops).toEqual(['bg11'])
    expect(store.ticket(1)?.state).toBe('done')
    const again = daemon.message(1, '再改一下')
    expect(again).toMatchObject({ ok: false, reason: expect.stringContaining('派新 ticket') })
    expect(store.ticket(1)?.state).toBe('done')
  })

  test('a Worker that fails to stop still closes its ticket', async () => {
    const { daemon, runtime, store } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    runtime.stop = () => Promise.reject(new Error('no such agent'))
    expect((await daemon.close(1)).ok).toBe(true)
    expect(store.ticket(1)?.state).toBe('done')
  })

  test('a ticket the Worker dropped keeps its Worker and can be reopened', async () => {
    const { daemon, runtime, store } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    daemon.done(1, 'dropped', '无事可做')
    expect(runtime.stops).toEqual([])
    expect(daemon.message(1, '其实有事').ok).toBe(true)
    expect(store.ticket(1)?.state).toBe('working')
  })
})

describe('questions', () => {
  test('an answer reaches a Worker still waiting on its ask (one started before asks returned at once)', async () => {
    const { daemon } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    const asked = daemon.ask(1, 'A 还是 B？', ['A', 'B'])
    const waiting = daemon.waitAnswer(asked.questionId as number, 5_000)
    const r = daemon.answer(1, 'A')
    expect(r).toMatchObject({ ok: true, result: { hadWaiter: true, workerName: 'agentd-w-1' } })
    await expect(waiting).resolves.toEqual({ answered: true, answer: 'A', withdrawn: false })
  })

  test('an ask answered at once, with nobody waiting, says so: the mod messages the Worker', async () => {
    const { daemon } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    daemon.ask(1, 'q?', null)
    expect(daemon.answer(1, 'x')).toMatchObject({ ok: true, result: { hadWaiter: false } })
  })

  test("a permission answer counts as fetched even between its hook's polls: never messaged", async () => {
    const { daemon, clock } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    daemon.ask(1, '要跑 git commit', ['批准', '拒绝'], { grantKey: 'k' })
    clock.now += 60_000
    expect(daemon.answer(1, '批准')).toMatchObject({ ok: true, result: { hadWaiter: true } })
  })

  test('a wait on an answered question returns at once; a wait times out empty', async () => {
    const { daemon } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    const asked = daemon.ask(1, 'q?', null)
    await expect(daemon.waitAnswer(asked.questionId as number, 10)).resolves.toEqual({
      answered: false,
      answer: null,
      withdrawn: false,
    })
    daemon.answer(1, 'y')
    await expect(daemon.waitAnswer(asked.questionId as number, 10)).resolves.toEqual({
      answered: true,
      answer: 'y',
      withdrawn: false,
    })
  })

  test('leaving asking without an answer withdraws the question and releases its waiter', async () => {
    const { daemon, store } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    const asked = daemon.ask(1, 'q?', null)
    const qid = asked.questionId as number
    const waiting = daemon.waitAnswer(qid, 5_000)
    await daemon.stop(1)
    await expect(waiting).resolves.toEqual({ answered: false, answer: null, withdrawn: true })
    // Nothing is left looking answerable, and a later wait is told the same.
    expect(store.ticket(1)?.openQuestion).toBeNull()
    expect(daemon.answer(1, 'late')).toMatchObject({ ok: false })
    await expect(daemon.waitAnswer(qid, 10)).resolves.toMatchObject({ withdrawn: true })
  })

  test('a Worker that exits mid-question leaves a failed ticket a message can wake', async () => {
    const { daemon, runtime, store, clock } = world()
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    daemon.ask(1, 'q?', null)
    runtime.workers = []
    clock.now += 21_000
    await settle(daemon)
    expect(store.ticket(1)).toMatchObject({ state: 'failed', openQuestion: null })
    expect(daemon.message(1, '再来').ok).toBe(true)
  })
})

describe('the event feed', () => {
  test('a long poll wakes on the next event', async () => {
    const { daemon, store } = world()
    const cursor = store.lastEventId()
    const polling = daemon.eventsSince(cursor, 5_000)
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    const events = await polling
    expect(events.map(e => e.kind)).toContain('dispatched')
  })

  test('isIdle is false while a ticket runs', async () => {
    const { daemon } = world()
    expect(daemon.isIdle()).toBe(true)
    daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
    expect(daemon.isIdle()).toBe(false)
  })
})

test('the MCP config path sits in the state folder', async () => {
  const { daemon, runtime } = world()
  daemon.dispatch({ project: 'memos', title: 't', prompt: 'p' })
  await settle(daemon)
  expect(runtime.spawns[0]?.mcpConfigPath.endsWith(join('mcp', '1.json'))).toBe(true)
})

describe('readonly tickets', () => {
  test('run without the file-writing tools, approval hooks as usual, and the readonly rule', async () => {
    const { daemon, runtime, store } = world()
    daemon.dispatch({ project: 'memos', title: '查一下', prompt: 'p', readonly: true })
    await settle(daemon)
    const spec = runtime.spawns[0]!
    expect(spec).toMatchObject({
      permissionMode: 'auto',
      disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    })
    expect(spec.settings).toBeDefined()
    expect(spec.systemPrompt).toContain('**只读**')
    expect(spec.systemPrompt).toContain('你没有写文件的工具')
    expect(store.ticket(1)).toMatchObject({ readonly: true, worktree: false })
  })

  test('in an MR project too: no lane, the project folder itself', async () => {
    const { daemon, runtime, lanes, root } = world({}, ['acme'])
    daemon.dispatch({ project: 'acme', title: '查', prompt: 'p', readonly: true })
    await settle(daemon)
    expect(lanes.created).toEqual([])
    expect(runtime.spawns[0]?.cwd).toBe(join(root, 'acme'))
  })
})

describe('MR tickets', () => {
  /** A acme ticket handed back ready, in its lane. */
  async function handedBack() {
    const w = world({}, ['acme'])
    w.daemon.dispatch({ project: 'acme', title: '改', prompt: 'p' })
    await settle(w.daemon)
    await w.daemon.done(1, 'ready', '改好了')
    return w
  }

  test('writing tickets of one project each get a lane and run side by side', async () => {
    const { daemon, runtime, lanes, store, root } = world({}, ['acme'])
    for (const title of ['a', 'b', 'c'])
      daemon.dispatch({ project: 'acme', title, prompt: 'p' })
    await settle(daemon)
    expect(runtime.spawns.map(s => s.name)).toEqual(['agentd-w-1', 'agentd-w-2', 'agentd-w-3'])
    const t = store.ticket(1)!
    expect(t).toMatchObject({ worktree: true, repoPath: join(root, 'acme') })
    expect(t.branch).toMatch(/^agentd\/1-[0-9a-z]+$/)
    expect(t.worktreePath).toBe(
      join(root, 'acme', '.claude', 'worktrees', t.branch!.replace('/', '-')),
    )
    expect(lanes.created.map(l => l.branch)).toEqual([1, 2, 3].map(i => store.ticket(i)!.branch))
    // The Worker runs in its lane and is told the branch and to leave the main folder alone.
    expect(runtime.spawns[0]).toMatchObject({ cwd: t.worktreePath, permissionMode: 'auto' })
    expect(runtime.spawns[0]?.systemPrompt).toContain(t.branch!)
    expect(runtime.spawns[0]?.systemPrompt).toContain('项目主目录')
    expect(runtime.spawns[0]?.systemPrompt).toContain('outcome=merged')
  })

  test('a lane that cannot be made fails the start with why; a retry makes it again', async () => {
    const { daemon, lanes, store } = world({}, ['acme'])
    lanes.failCreate = 'git fetch origin main 失败'
    daemon.dispatch({ project: 'acme', title: 'a', prompt: 'p' })
    await settle(daemon)
    expect(store.ticket(1)?.state).toBe('failed')
    expect(store.eventsOf(1).at(-1)?.summary).toContain('建 worktree 失败')
    lanes.failCreate = null
    await daemon.retry(1)
    await settle(daemon)
    expect(store.ticket(1)?.state).toBe('working')
  })

  test('closing one before its merge is giving it up: refused without discard', async () => {
    const { daemon, lanes, runtime, store } = await handedBack()
    const refused = await daemon.close(1)
    expect(refused).toMatchObject({ ok: false })
    expect(refused.ok ? '' : refused.reason).toContain('discard')
    expect(store.ticket(1)?.state).toBe('ready')
    expect((await daemon.close(1, true)).ok).toBe(true)
    expect(lanes.cleaned).toEqual([
      {
        lane: expect.objectContaining({ branch: store.ticket(1)?.branch ?? expect.any(String) }),
        mode: 'discard',
      },
    ])
    expect(runtime.stops).toEqual(['bg11'])
    expect(store.ticket(1)).toMatchObject({ state: 'done', worktreePath: null })
    expect(store.eventsOf(1).at(-1)).toMatchObject({ kind: 'cleaned' })
  })

  test('open MR → merged: checked against origin, then the Worker stops and the lane goes', async () => {
    const { daemon, lanes, runtime, store } = await handedBack()
    const branch = store.ticket(1)!.branch!
    // merged is only for after the person asked for the MR.
    expect((await daemon.done(1, 'merged', 'x')).ok).toBe(false)
    expect(daemon.openMr(1)).toMatchObject({
      ok: true,
      ticket: { state: 'working', mrOpened: true },
    })
    // Reports and questions in the MR phase keep the ticket in it.
    daemon.ask(1, '冲突两边都改了，留哪个？', null)
    daemon.answer(1, '留 main 的')
    expect(store.ticket(1)).toMatchObject({ state: 'working', mrOpened: true })
    // origin still has the branch: not merged yet.
    lanes.remote.add(branch)
    const early = await daemon.done(1, 'merged', 'MR !12')
    expect(early.ok ? '' : early.reason).toContain('还有分支')
    lanes.remote.delete(branch)
    expect((await daemon.done(1, 'merged', 'MR !12 已合入')).ok).toBe(true)
    await settle(daemon)
    expect(runtime.stops).toEqual(['bg11'])
    expect(lanes.cleaned).toMatchObject([{ lane: { branch }, mode: 'merged' }])
    expect(store.ticket(1)).toMatchObject({ state: 'done', worktreePath: null, branch: null })
    // Its Worker is gone and its folder with it: nothing to send to.
    expect(daemon.message(1, '再改一下').ok).toBe(false)
  })

  test('opening the MR shows as the answer to the hand-back, until the Worker says more', async () => {
    const { daemon, store } = await handedBack()
    expect(store.ticket(1)).toMatchObject({ lastReport: '改好了', lastAnswer: null })
    daemon.openMr(1)
    expect(store.ticket(1)).toMatchObject({ lastReport: '改好了', lastAnswer: '开 MR' })
    daemon.report(1, '已推送，PR #3 在跑检查')
    expect(store.ticket(1)).toMatchObject({
      lastReport: '已推送，PR #3 在跑检查',
      lastAnswer: null,
    })
  })

  test('the other things the person does to a ticket are not shown as answers', async () => {
    const { daemon, store } = await handedBack()
    daemon.message(1, '顺手改个错别字')
    expect(store.ticket(1)?.lastAnswer).toBeNull()
    await daemon.stop(1)
    await daemon.resume(1)
    expect(store.ticket(1)?.lastAnswer).toBeNull()
    await daemon.close(1, true)
    expect(store.ticket(1)?.lastAnswer).toBeNull()
  })

  test('only a ready MR ticket can have its MR opened', async () => {
    const { daemon } = world({}, ['acme'])
    daemon.dispatch({ project: 'acme', title: 'a', prompt: 'p' })
    daemon.dispatch({ project: 'memos', title: 'b', prompt: 'p' })
    await settle(daemon)
    expect(daemon.openMr(1).ok).toBe(false)
    await daemon.done(2, 'ready', 'ok')
    expect(daemon.openMr(2).ok).toBe(false)
  })

  test('an MR request its Worker never got is taken back: ready again, as if never asked', async () => {
    const { daemon, store } = await handedBack()
    const before = store.eventsOf(1).map(e => e.kind)
    daemon.openMr(1)
    expect(daemon.undoOpenMr(1)).toMatchObject({
      ok: true,
      ticket: { state: 'ready', mrOpened: false, lastAnswer: null },
    })
    expect(store.eventsOf(1).map(e => e.kind)).toEqual(before)
    // The「开 MR」button works again.
    expect(daemon.openMr(1).ok).toBe(true)
  })

  test('an MR request is not taken back once anything followed it', async () => {
    const { daemon, store } = await handedBack()
    expect(daemon.undoOpenMr(1).ok).toBe(false)
    daemon.openMr(1)
    daemon.report(1, '已推送')
    expect(daemon.undoOpenMr(1).ok).toBe(false)
    expect(store.ticket(1)).toMatchObject({ state: 'working', mrOpened: true })
  })

  test('dropped removes the lane outright', async () => {
    const { daemon, lanes } = world({}, ['acme'])
    daemon.dispatch({ project: 'acme', title: 'a', prompt: 'p' })
    await settle(daemon)
    await daemon.done(1, 'dropped', '已经修过了')
    await settle(daemon)
    expect(lanes.cleaned.map(c => c.mode)).toEqual(['discard'])
  })

  test('a lane that cannot go is kept and said; a later sweep tries again', async () => {
    const { daemon, lanes, store } = await handedBack()
    daemon.openMr(1)
    lanes.keep = true
    await daemon.done(1, 'merged', '已合入')
    await settle(daemon)
    expect(store.eventsOf(1).at(-1)).toMatchObject({ kind: 'kept' })
    expect(store.ticket(1)?.worktreePath).not.toBeNull()
    expect(store.unclean().map(t => t.id)).toEqual([1])
    lanes.keep = false
    await daemon.sweep()
    expect(lanes.cleaned.map(c => c.mode)).toEqual(['merged', 'merged'])
    expect(store.unclean()).toEqual([])
  })

  test('a stopped MR ticket keeps its lane, to be resumed', async () => {
    const { daemon, lanes, store } = world({}, ['acme'])
    daemon.dispatch({ project: 'acme', title: 'a', prompt: 'p' })
    await settle(daemon)
    await daemon.stop(1)
    await daemon.sweep()
    expect(lanes.cleaned).toEqual([])
    expect(store.ticket(1)?.worktreePath).not.toBeNull()
  })
})

describe('delivery by folder', () => {
  test('one folder key covers its repositories, a nearer key overrides, the default covers the rest', async () => {
    const probe = world()
    const root = probe.root
    const { daemon, store } = world({
      roots: [root],
      projects: {
        [root]: { delivery: 'mr' },
        [join(root, 'billboard')]: { delivery: 'local' },
      },
    })
    for (const project of ['memos', 'acme', 'billboard'])
      daemon.dispatch({ project, title: project, prompt: 'p' })
    await settle(daemon)
    expect([1, 2, 3].map(i => store.ticket(i)?.worktree)).toEqual([true, true, false])
    const everywhere = world({ roots: [root], defaultDelivery: 'mr' })
    everywhere.daemon.dispatch({ project: 'memos', title: 'm', prompt: 'p' })
    expect(everywhere.store.ticket(1)?.worktree).toBe(true)
  })

  test('a folder set to mr: repos that cannot take an MR stay local and say why; GitHub ones use gh', async () => {
    const root = world().root
    const { daemon, store, lanes, runtime } = world({
      roots: [root],
      projects: { [root]: { delivery: 'mr' } },
      githubOwners: ['kid551'],
    })
    lanes.origins.set(join(root, 'memos'), { url: null, hasBase: false })
    lanes.origins.set(join(root, 'acme'), {
      url: 'git@github.com:kid551/acme.git',
      hasBase: true,
    })
    lanes.origins.set(join(root, 'billboard'), {
      url: 'git@github.com:someone/billboard.git',
      hasBase: true,
    })
    const results = [
      daemon.dispatch({ project: 'memos', title: 'a', prompt: 'p' }),
      daemon.dispatch({ project: 'memos', title: 'b', prompt: 'p' }),
      daemon.dispatch({ project: 'acme', title: 'c', prompt: 'p' }),
      daemon.dispatch({ project: 'acme', title: 'd', prompt: 'p' }),
      daemon.dispatch({ project: 'billboard', title: 'e', prompt: 'p' }),
    ]
    await settle(daemon)
    expect([1, 2, 3, 4, 5].map(i => store.ticket(i)?.worktree)).toEqual([
      false,
      false,
      true,
      true,
      false,
    ])
    const notes = results.map(r => (r.ok ? r.note : undefined))
    expect(notes[0]).toContain('没有 origin')
    expect(notes[2]).toBeUndefined()
    expect(notes[4]).toContain('someone')
    // The local fallback is still one writing Worker at a time; the GitHub lanes run side by side.
    expect(store.ticket(2)?.state).toBe('queued')
    expect(store.ticket(4)?.state).toBe('working')
    const prompt = (name: string) => runtime.spawns.find(s => s.name === name)?.systemPrompt
    expect(prompt('agentd-w-3')).toContain('gh pr create')
    expect(prompt('agentd-w-1')).not.toContain('gh pr create')
  })

  test('a readonly ticket does not probe; a GitLab MR ticket keeps the GitLab words', async () => {
    const { daemon, runtime, lanes } = world({}, ['acme'])
    lanes.probe = () => {
      throw new Error('probed')
    }
    daemon.dispatch({ project: 'acme', title: '查', prompt: 'p', readonly: true })
    await settle(daemon)
    expect(runtime.spawns).toHaveLength(1)
    const gitlab = world({}, ['acme'])
    gitlab.daemon.dispatch({ project: 'acme', title: '改', prompt: 'p' })
    await settle(gitlab.daemon)
    expect(gitlab.runtime.spawns[0]?.systemPrompt).toContain('项目文档优先于任何合并脚本')
    expect(gitlab.runtime.spawns[0]?.systemPrompt).not.toContain('gh pr')
  })
})
