import { describe, expect, it } from 'vitest'

import { phaseWord, transition } from '../src/core/state.js'
import { cut, digest, overview, workerPrompt } from '../src/core/text.js'
import type { Ticket } from '../src/core/types.js'
import { Board } from '../src/host/board.js'
import { memoryTables } from '../src/host/tables.js'
import { actionsOf, bandOf, bandText, groups, nextNeeding } from '../src/client/view.js'
import type { TicketView } from '../src/host/http.js'
// @ts-expect-error: plain ESM script without types
import { block, withBlock } from '../scripts/install.mjs'

describe('state machine', () => {
  it('interrupts only running tickets and resumes them', () => {
    expect(transition('working', 'interrupted')).toEqual({ ok: true, to: 'interrupted' })
    expect(transition('ready', 'interrupted').ok).toBe(false)
    expect(transition('interrupted', 'resume')).toEqual({ ok: true, to: 'working' })
    expect(transition('stopped', 'resume')).toEqual({ ok: true, to: 'working' })
  })
  it('keeps an open question open when the person or Router adds instructions', () => {
    expect(transition('asking', 'user_said')).toEqual({ ok: true, to: 'asking' })
    expect(transition('asking', 'message')).toEqual({ ok: true, to: 'asking' })
    expect(transition('asking', 'answered')).toEqual({ ok: true, to: 'working' })
  })
  it('refuses with a reason naming the state', () => {
    const r = transition('stopped', 'message')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('已停')
  })
})

describe('text', () => {
  it('cuts long bodies and says so', () => {
    expect(cut('abc', 5)).toEqual({ text: 'abc', isCut: false })
    expect(cut('abcdefgh', 5)).toEqual({ text: 'abcde…', isCut: true })
  })
  it('digests events with headers and spill hints', () => {
    const text = digest([
      {
        ticketId: 3,
        project: 'p',
        title: 't',
        kind: 'ask',
        summary: 'A 还是 B',
        isCut: true,
        priorReport: '查到了',
      },
    ])
    expect(text).toContain('【#3 · p · t】')
    expect(text).toContain('superagent_read 取 #3')
    expect(text).toContain('此前进展：查到了')
  })
  it('lists the tickets waiting for the person first in the overview', () => {
    const base = {
      title: 't',
      task: '',
      executor: 'dsh',
      project: 'p',
      projectPath: '/p',
      worktree: false,
      createdAt: 0,
      updatedAt: 0,
    } as const
    const tickets: Ticket[] = [
      { ...base, id: 1, state: 'working' },
      { ...base, id: 2, state: 'ready', lastReport: '好了' },
      { ...base, id: 3, state: 'done' },
    ]
    const text = overview(tickets)
    expect(text.indexOf('#2')).toBeLessThan(text.indexOf('#1'))
    expect(text).not.toContain('#3')
  })
})

describe('board', () => {
  it('trims events of ended tickets and keeps undelivered bookkeeping', async () => {
    const board = new Board(memoryTables())
    const t = await board.create({
      title: 't',
      task: 'x',
      executor: 'dsh',
      project: 'p',
      projectPath: '/p',
      worktree: false,
    })
    await board.apply(t.id, 'spawn_ok', '', 'superagent')
    for (let i = 0; i < 60; i++) await board.apply(t.id, 'report', `r${i}`, 'worker')
    await board.apply(t.id, 'done_ready', '好了', 'worker')
    const { items, lastId } = board.undelivered(300)
    expect(items.map(i => i.kind)).toEqual(['ready'])
    await board.markSeen(lastId)
    expect(board.undelivered(300).items).toHaveLength(0)
    await board.apply(t.id, 'close', '', 'you')
    expect(board.eventsOf(t.id).length).toBeLessThanOrEqual(50)
    expect(board.get(t.id)?.lastReport).toBe('好了')
  })
})

describe('client view', () => {
  const view = (id: number, state: TicketView['state'], sessionId?: string): TicketView => ({
    id,
    title: `t${id}`,
    task: '',
    executor: 'dsh',
    project: 'p',
    projectPath: '/p',
    worktree: false,
    state,
    createdAt: 0,
    updatedAt: 0,
    needsMe: ['asking', 'ready', 'blocked', 'failed', 'interrupted'].includes(state),
    ...(sessionId ? { sessionId } : {}),
  })
  it('groups and offers the right buttons', () => {
    const tickets = [
      view(1, 'working', 's1'),
      view(2, 'asking', 's2'),
      view(3, 'done', 's3'),
      view(4, 'interrupted', 's4'),
    ]
    expect(groups(tickets).map(g => [g.key, g.tickets.map(t => t.id)])).toEqual([
      ['needs', [2, 4]],
      ['active', [1]],
      ['ended', [3]],
    ])
    expect(actionsOf(view(4, 'interrupted', 's4'))).toEqual(['chat', 'resume', 'close'])
    expect(actionsOf(view(5, 'queued'))).toEqual(['stop', 'close'])
    expect(nextNeeding(tickets, 2)?.id).toBe(4)
    expect(nextNeeding(tickets, 4)?.id).toBe(2)
  })
  it('an MR ticket under review offers 开 MR and 放弃, never a plain 收', () => {
    const mr = {
      ...view(6, 'ready', 's6'),
      worktree: true,
      worktreePath: '/p/wt',
      branch: 'superagent/6-x',
    }
    expect(actionsOf(mr)).toEqual(['chat', 'open_mr', 'discard'])
    expect(actionsOf({ ...mr, state: 'working', mrOpened: true })).toEqual([
      'chat',
      'stop',
      'discard',
    ])
    expect(phaseWord(mr)).toBe('待审')
    expect(phaseWord({ ...mr, state: 'working', mrOpened: true })).toBe('MR 中')
  })
  it('the Worker is told where it writes: its lane, the folder, or nowhere', () => {
    const base = { id: 6, title: 't', projectPath: '/p', worktree: false }
    expect(workerPrompt({ ...base, readonly: true })).toContain('**只读**')
    expect(workerPrompt({ ...base, readonly: true })).not.toContain('你没有写文件的工具')
    const mr = workerPrompt({
      ...base,
      worktree: true,
      worktreePath: '/p/wt',
      branch: 'superagent/6-x',
    })
    expect(mr).toContain('superagent/6-x')
    expect(mr).toContain('outcome=merged')
    expect(workerPrompt(base)).toContain('当前分支上工作')
  })
  it('tells Router and Worker Sessions apart in the band', () => {
    const state = { routerSessionId: 'r', tickets: [view(2, 'asking', 's2')], now: 0 }
    expect(bandText(bandOf(state, 'r'))).toBe('对 Router 说 · 待处理 1')
    expect(bandText(bandOf(state, 's2'))).toBe('单聊 #2 · p · t2（等你）· Router 待处理 1')
    expect(bandOf(state, 'other').kind).toBe('none')
  })
  it("keeps the Router's counts in a Worker's band, leaving out the zeros", () => {
    const tickets = [view(2, 'asking', 's2'), view(3, 'working', 's3'), view(4, 'queued')]
    const state = { routerSessionId: 'r', tickets, now: 0 }
    expect(bandText(bandOf(state, 's3'))).toBe(
      '单聊 #3 · p · t3（在干）· Router 待处理 1 · 进行中 2',
    )
    const alone = { routerSessionId: 'r', tickets: [view(3, 'done', 's3')], now: 0 }
    expect(bandText(bandOf(alone, 's3'))).toBe('单聊 #3 · p · t3（已结束）')
  })
})

describe('install block', () => {
  it('adds, replaces and removes exactly one managed block', () => {
    const user = '- id: locale\n  config:\n    preference: zh\n'
    const once = withBlock(user, block('aaa'))
    const twice = withBlock(once, block('aaa'))
    expect(twice).toBe(once)
    expect(once.startsWith(user)).toBe(true)
    expect(withBlock(twice, '')).toBe(user)
    // a new build replaces the block instead of adding a second one
    const rebuilt = withBlock(once, block('bbb'))
    expect(rebuilt).toContain('# build bbb')
    expect(rebuilt).not.toContain('# build aaa')
  })
})
