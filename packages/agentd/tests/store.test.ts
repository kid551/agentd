import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { cut, Store } from '../src/store.js'

const project = { id: 'memos', path: '/r/memos', root: '/r' }

function fresh(now = () => 1_000): Store {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'agentd-store-')), 'a.db'), {
    now,
    inlineChars: 40,
  })
  store.replaceProjects([project])
  return store
}

describe('Store', () => {
  test('a new ticket is queued, named after its id, and records its dispatch', () => {
    const store = fresh()
    const t = store.createTicket({
      title: '修复',
      project,
      prompt: '修一下',
      model: 'opus',
      worktree: false,
    })
    expect(t).toMatchObject({
      id: 1,
      state: 'queued',
      workerName: 'agentd-w-1',
      project: 'memos',
      cwd: '/r/memos',
    })
    expect(store.eventsSince(0).map(e => e.kind)).toEqual(['dispatched'])
  })

  test('a refused input changes nothing and records nothing', () => {
    const store = fresh()
    const t = store.createTicket({
      title: 't',
      project,
      prompt: 'p',
      model: 'opus',
      worktree: false,
    })
    const r = store.apply(t.id, 'answer', 'you', { text: 'x' })
    expect(r.ok).toBe(false)
    expect(store.ticket(t.id)?.state).toBe('queued')
    expect(store.eventsSince(0)).toHaveLength(1)
  })

  test('ask then answer moves through asking and back, closing the question', () => {
    const store = fresh()
    const t = store.createTicket({
      title: 't',
      project,
      prompt: 'p',
      model: 'opus',
      worktree: false,
    })
    store.apply(t.id, 'spawn_ok', 'agentd')
    const asked = store.ask(t.id, '固定行高可以吗？', ['可以', '不行'])
    expect(asked.ok).toBe(true)
    expect(store.ticket(t.id)).toMatchObject({
      state: 'asking',
      needsMe: true,
      openQuestion: { question: '固定行高可以吗？', options: ['可以', '不行'] },
    })
    const answered = store.answer(t.id, '可以')
    expect(answered.ok).toBe(true)
    expect(store.ticket(t.id)).toMatchObject({ state: 'working', openQuestion: null })
    expect(store.question(asked.questionId as number)).toMatchObject({ answer: '可以' })
    expect(store.answer(t.id, '再答一次').ok).toBe(false)
  })

  test('a failed ask leaves no question behind', () => {
    const store = fresh()
    const t = store.createTicket({
      title: 't',
      project,
      prompt: 'p',
      model: 'opus',
      worktree: false,
    })
    expect(store.ask(t.id, 'q?', null).ok).toBe(false)
    expect(store.openQuestion(t.id)).toBeNull()
  })

  test('reports set the last report; ended tickets get an end time', () => {
    let at = 1_000
    const store = fresh(() => at)
    const t = store.createTicket({
      title: 't',
      project,
      prompt: 'p',
      model: 'opus',
      worktree: false,
    })
    store.apply(t.id, 'spawn_ok', 'agentd')
    store.apply(t.id, 'report', 'worker', { text: '定位到根因' })
    at = 2_000
    store.apply(t.id, 'done_ready', 'worker', { text: '改完了，测试通过' })
    expect(store.ticket(t.id)).toMatchObject({
      state: 'ready',
      lastReport: '改完了，测试通过',
      endedAt: null,
    })
    store.apply(t.id, 'close', 'you')
    expect(store.ticket(t.id)).toMatchObject({ state: 'done', endedAt: 2_000 })
    expect(store.listTickets('open')).toHaveLength(0)
    expect(store.listTickets('recent')).toHaveLength(1)
  })

  test('the last message is whatever the Worker or agentd said last, questions included', () => {
    const store = fresh()
    const make = (): number =>
      store.createTicket({ title: 't', project, prompt: 'p', model: 'opus', worktree: false }).id
    const last = (id: number): string | null | undefined => store.ticket(id)?.lastReport

    const a = make()
    store.apply(a, 'spawn_ok', 'agentd', { text: 'Worker bg-1 已启动' })
    expect(last(a)).toBeNull()
    store.apply(a, 'report', 'worker', { text: '定位到根因' })
    store.ask(a, '用方案 A 还是 B？', ['A', 'B'])
    expect(last(a)).toBe('用方案 A 还是 B？')
    // The person's own words are not the ticket's latest message.
    store.apply(a, 'message', 'you', { text: '顺便看下日志' })
    store.answer(a, 'A')
    expect(last(a)).toBe('用方案 A 还是 B？')
    store.ask(a, '**权限请求**：Worker 想用 `Bash`', null, { grantKey: 'k' })
    expect(last(a)).toBe('**权限请求**：Worker 想用 `Bash`')
    store.answer(a, '批准')
    store.apply(a, 'report', 'worker', { text: '改完一处' })
    expect(last(a)).toBe('改完一处')
    store.apply(a, 'done_blocked', 'worker', { text: '卡在权限' })
    expect(last(a)).toBe('卡在权限')
  })

  test("the person's answer rides under the question it answered, until the Worker says more", () => {
    const store = fresh()
    const make = (): number =>
      store.createTicket({ title: 't', project, prompt: 'p', model: 'opus', worktree: false }).id
    const answer = (id: number): string | null | undefined => store.ticket(id)?.lastAnswer

    const a = make()
    store.apply(a, 'spawn_ok', 'agentd')
    expect(answer(a)).toBeNull()
    store.ask(a, '用方案 A 还是 B？', ['A', 'B'])
    expect(answer(a)).toBeNull()
    store.answer(a, '用 A，\n  别动 B')
    expect(store.ticket(a)).toMatchObject({
      lastReport: '用方案 A 还是 B？',
      lastAnswer: '用 A， 别动 B',
    })
    // An instruction is not an answer, and leaves the shown one alone.
    store.apply(a, 'message', 'you', { text: '顺便看下日志' })
    expect(answer(a)).toBe('用 A， 别动 B')
    // The Worker's next message replaces both.
    store.apply(a, 'report', 'worker', { text: '改完一处' })
    expect(store.ticket(a)).toMatchObject({ lastReport: '改完一处', lastAnswer: null })

    // A permission answer shows only which way it went.
    store.ask(a, '**权限请求**：Worker 想用 `Bash`', null, { grantKey: 'k' })
    store.answer(a, '批准。')
    expect(answer(a)).toBe('批准')
    store.apply(a, 'report', 'worker', { text: '跑完了' })
    store.ask(a, '**权限请求**：Worker 想用 `Edit`', null, { grantKey: 'k2' })
    store.answer(a, '不行，换个办法')
    expect(answer(a)).toBe('拒绝')

    // A long answer is cut; the whole stays in the event.
    store.ask(a, '怎么改？', null)
    store.answer(a, '这样改。'.repeat(100))
    expect(answer(a)).toHaveLength(200)
    expect(answer(a)?.endsWith('…')).toBe(true)
    expect(store.eventsOf(a, 1)[0]?.body.text).toBe('这样改。'.repeat(100))

    // The Worker said something else while asking: the answer is not to the latest message.
    const b = make()
    store.apply(b, 'spawn_ok', 'agentd')
    store.ask(b, '要不要删旧表？', null)
    store.apply(b, 'report', 'worker', { text: '先查了下引用' })
    store.answer(b, '删')
    expect(store.ticket(b)).toMatchObject({ lastReport: '先查了下引用', lastAnswer: null })

    // A withdrawn question has no answer.
    const c = make()
    store.apply(c, 'spawn_ok', 'agentd')
    store.ask(c, '继续吗？', null)
    store.apply(c, 'stop', 'you')
    expect(store.ticket(c)).toMatchObject({ lastReport: '继续吗？', lastAnswer: null })
  })

  test('an answer that only picks an option shows the option it picked', () => {
    const store = fresh()
    const id = store.createTicket({
      title: 't',
      project,
      prompt: 'p',
      model: 'opus',
      worktree: false,
    }).id
    store.apply(id, 'spawn_ok', 'agentd')
    const shown = (options: string[] | null, text: string): string | null | undefined => {
      store.ask(id, '选哪个？', options)
      store.answer(id, text)
      const answer = store.ticket(id)?.lastAnswer
      store.apply(id, 'report', 'worker', { text: '收到' })
      return answer
    }
    const plain = ['只改 agentd', '两边都做', '另开一张']
    // A letter or a number, said any of these ways, names the option by its place.
    for (const text of ['B', 'b', 'B。', ' b. ', '选B', '选择 B', '2', '选 2', '2！'])
      expect(shown(plain, text)).toBe('B. 两边都做')
    // An option that carries its own label is shown as it is.
    const labelled = ['A（倾向）：只看本地', 'B：加白名单', 'C：联网测推送']
    expect(shown(labelled, 'B')).toBe('B：加白名单')
    expect(shown(labelled, '2')).toBe('B：加白名单')
    expect(shown(['1（倾向）：回环地址', '2：不设', '3：用户入口'], '2')).toBe('2：不设')
    // Anything more than the pick is kept as said: what else it says is not guessed at.
    expect(shown(labelled, '先选择2吧')).toBe('先选择2吧')
    expect(shown(labelled, 'B。 alice@example.com')).toBe('B。 alice@example.com')
    expect(shown(labelled, 'A 和 C 都要')).toBe('A 和 C 都要')
    // No such option, no options, or the answer is an option's own words.
    expect(shown(plain, 'D')).toBe('D')
    expect(shown(null, 'A')).toBe('A')
    expect(shown(['2', '3'], '2')).toBe('2')
    // The option is cut like any answer; the event keeps what was said.
    expect(shown(['长'.repeat(300), '短'], 'A')).toHaveLength(200)
    expect(store.eventsOf(id, 2)[0]?.body.text).toBe('A')
  })

  test('a hand-back in the feed carries the progress report before it, cut; others carry none', () => {
    const store = fresh()
    const make = (): number =>
      store.createTicket({ title: 't', project, prompt: 'p', model: 'opus', worktree: false }).id
    const [a, b] = [make(), make()] as [number, number]
    store.apply(a, 'spawn_ok', 'agentd')
    store.apply(b, 'spawn_ok', 'agentd')
    store.apply(a, 'report', 'worker', { text: '旧的' })
    store.apply(a, 'report', 'worker', { text: `定位到根因${'x'.repeat(60)}` })
    // Another ticket's report in between is not this ticket's context.
    store.apply(b, 'report', 'worker', { text: 'b 的进展' })
    store.ask(a, 'A 还是 B？', ['A', 'B'])
    store.answer(a, 'A')
    store.apply(a, 'report', 'worker', { text: '按 A 改完' })
    store.apply(a, 'done_ready', 'worker', { text: '好了' })
    store.ask(b, 'b 问？', null)
    const feed = store.eventsSince(0)
    const of = (kind: string, ticketId: number) =>
      feed.find(e => e.kind === kind && e.ticketId === ticketId)?.priorReport
    expect(of('ask', a)).toMatch(/^定位到根因x+…$/)
    expect(of('ask', a)).toHaveLength(40)
    expect(of('ask', b)).toBe('b 的进展')
    expect(of('ready', a)).toBeNull()
    expect(of('progress', a)).toBeNull()
    expect(store.eventsOf(a).every(e => e.priorReport === null)).toBe(true)
  })

  test('the list filters select by state and age, each ticket carrying its open question', () => {
    let at = 1_000
    const store = fresh(() => at)
    const make = (): number =>
      store.createTicket({ title: 't', project, prompt: 'p', model: 'opus', worktree: false }).id
    const [asking, working, oldDone, newDone] = [make(), make(), make(), make()] as [
      number,
      number,
      number,
      number,
    ]
    for (const id of [asking, working, oldDone, newDone]) store.apply(id, 'spawn_ok', 'agentd')
    store.ask(asking, 'A 还是 B？', ['A', 'B'])
    store.apply(oldDone, 'close', 'you')
    at = 1_000 + 25 * 3600 * 1000
    store.apply(newDone, 'close', 'you')
    const ids = (filter: Parameters<Store['listTickets']>[0]): number[] =>
      store.listTickets(filter).map(t => t.id)
    expect(ids('all')).toEqual([asking, working, oldDone, newDone])
    expect(ids('open')).toEqual([asking, working])
    expect(ids('needs_me')).toEqual([asking])
    expect(ids('recent')).toEqual([asking, working, newDone])
    const rows = store.listTickets('open')
    expect(rows[0]?.openQuestion).toMatchObject({ question: 'A 还是 B？', options: ['A', 'B'] })
    expect(rows[1]?.openQuestion).toBeNull()
  })

  test('leaving asking by any input but answer withdraws the open question', () => {
    const store = fresh()
    const t = store.createTicket({
      title: 't',
      project,
      prompt: 'p',
      model: 'opus',
      worktree: false,
    })
    store.apply(t.id, 'spawn_ok', 'agentd')
    const asked = store.ask(t.id, 'q?', null)
    // A report while asking keeps the question.
    store.apply(t.id, 'report', 'worker', { text: '还在等' })
    expect(store.ticket(t.id)?.openQuestion).not.toBeNull()
    const moved = store.apply(t.id, 'done_ready', 'worker', { text: '不等了' })
    expect(moved).toMatchObject({ ok: true, withdrawnQuestionId: asked.questionId })
    expect(store.ticket(t.id)?.openQuestion).toBeNull()
    expect(store.question(asked.questionId as number)).toMatchObject({
      answeredAt: 1_000,
      answer: null,
    })
  })

  test('a message reopens a done ticket and records it', () => {
    const store = fresh()
    const t = store.createTicket({
      title: 't',
      project,
      prompt: 'p',
      model: 'opus',
      worktree: false,
    })
    store.apply(t.id, 'spawn_ok', 'agentd')
    store.apply(t.id, 'done_ready', 'worker', { text: 'ok' })
    store.apply(t.id, 'close', 'you')
    expect(store.apply(t.id, 'message', 'router', { text: '再改一下' }).ok).toBe(true)
    expect(store.ticket(t.id)).toMatchObject({ state: 'working', endedAt: null })
    expect(
      store
        .eventsOf(t.id)
        .map(e => e.kind)
        .slice(-2),
    ).toEqual(['reopened', 'message'])
  })

  test('the feed cuts long text and carries the ticket header', () => {
    const store = fresh()
    const t = store.createTicket({
      title: '标题',
      project,
      prompt: 'x'.repeat(100),
      model: 'opus',
      worktree: false,
    })
    const [event] = store.eventsSince(0)
    expect(event).toMatchObject({
      isCut: true,
      ticket: { id: t.id, title: '标题', project: 'memos' },
    })
    expect(event?.summary.length).toBe(40)
    expect(store.eventsOf(t.id)[0]?.body.text).toHaveLength(100)
  })

  test('rescanning with a same-named repository renames both without a clash', () => {
    const store = fresh()
    store.replaceProjects([
      { id: 'a/memos', path: '/r/a/memos', root: '/r' },
      { id: 'memos-x', path: '/r/memos', root: '/r' },
    ])
    expect(store.listProjects().map(p => p.id)).toEqual(['a/memos', 'memos-x'])
  })

  test('migrations run once; reopening keeps the data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentd-store-'))
    const a = new Store(join(dir, 'a.db'))
    a.replaceProjects([project])
    a.createTicket({ title: 't', project, prompt: 'p', model: 'opus', worktree: false })
    a.close()
    const b = new Store(join(dir, 'a.db'))
    expect(b.ticket(1)?.title).toBe('t')
  })

  test('a question asked before the kind column existed reads as a plain question', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentd-store-'))
    const a = new Store(join(dir, 'a.db'))
    a.replaceProjects([project])
    a.createTicket({ title: 't', project, prompt: 'p', model: 'opus', worktree: false })
    a.apply(1, 'spawn_ok', 'agentd')
    a.ask(1, '哪个？', null)
    // Roll the database back to version 2, as an older agentd left it.
    a.db.exec(`ALTER TABLE questions DROP COLUMN kind; ALTER TABLE questions DROP COLUMN grant_key;
               ${V4_COLUMNS.map(c => `ALTER TABLE tickets DROP COLUMN ${c};`).join(' ')}
               PRAGMA user_version = 2;`)
    a.close()
    const b = new Store(join(dir, 'a.db'))
    expect(b.ticket(1)?.openQuestion).toMatchObject({ kind: 'ask', question: '哪个？' })
    expect(b.openQuestion(1)?.grantKey).toBeNull()
  })

  test('a ticket from before parallel tickets reads as a local, writing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentd-store-'))
    const a = new Store(join(dir, 'a.db'))
    a.replaceProjects([project])
    a.createTicket({ title: 't', project, prompt: 'p', model: 'opus', worktree: false })
    a.db.exec(`${V4_COLUMNS.map(c => `ALTER TABLE tickets DROP COLUMN ${c};`).join(' ')}
               PRAGMA user_version = 3;`)
    a.close()
    const b = new Store(join(dir, 'a.db'))
    expect(b.ticket(1)).toMatchObject({
      readonly: false,
      worktree: false,
      branch: null,
      worktreePath: null,
      mrOpened: false,
      lastAnswer: null,
    })
  })

  test('a ticket from before answers were kept shows none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentd-store-'))
    const a = new Store(join(dir, 'a.db'))
    a.replaceProjects([project])
    a.createTicket({ title: 't', project, prompt: 'p', model: 'opus', worktree: false })
    a.db.exec('ALTER TABLE tickets DROP COLUMN last_answer; PRAGMA user_version = 4;')
    a.close()
    const b = new Store(join(dir, 'a.db'))
    expect(b.ticket(1)?.lastAnswer).toBeNull()
  })

  test('a permission question keeps its kind and grant key', () => {
    const store = fresh()
    store.createTicket({ title: 't', project, prompt: 'p', model: 'opus', worktree: false })
    store.apply(1, 'spawn_ok', 'agentd')
    store.ask(1, '权限请求', ['批准', '拒绝'], { grantKey: 'Bash {}' })
    expect(store.ticket(1)?.openQuestion?.kind).toBe('permission')
    expect(store.openQuestion(1)).toMatchObject({ kind: 'permission', grantKey: 'Bash {}' })
  })
})

/** Columns added from version 4 on, dropped to roll a database back to version 3. */
const V4_COLUMNS = [
  'readonly',
  'branch',
  'worktree_path',
  'repo_path',
  'mr_opened_at',
  'last_answer',
]

test('cut keeps short text and flattens whitespace', () => {
  expect(cut(' a \n b ', 10)).toEqual({ text: 'a b', isCut: false })
  expect(cut('abcdef', 4)).toEqual({ text: 'abc…', isCut: true })
})
