import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import { lite } from '../hooks/api'
import {
  ago,
  cardText,
  endedPage,
  isLong,
  chatNote,
  LINK,
  mentionDepth,
  openMrMessage,
  overview,
  phaseWord,
  ROUTER_PROMPT,
  projectColor,
  seconds,
  stateLook,
  ticketSections,
} from '../hooks/text'

// A card's light controls are markdown links: pressed by their href, drawn as their source.
const link = (key: string) => ({ key, link: { href: `${LINK}${key}` } })
const linked = (label: string, key: string) => `[${label}](${LINK}${key})`

// Nothing sits beneath the plugin in a test: these hooks stand for the engine,
// and `fakeDaemon` answers $.http.fetch as the agentd daemon would.

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }
type TicketFixture = Record<string, unknown>

const asking: TicketFixture = {
  id: 1,
  title: '修复列表滚动掉帧',
  project: 'acme-flutter',
  cwd: '/r/acme-flutter',
  state: 'asking',
  needsMe: true,
  workerName: 'agentd-w-1',
  workerSessionId: 'sess-1',
  workerBgId: 'bg1',
  lastReport: '定位到 itemExtent',
  openQuestion: { id: 7, question: '固定行高可以吗？', options: ['可以', '用 prototypeItem'] },
  updatedAt: 10,
}
const working: TicketFixture = {
  ...asking,
  id: 2,
  title: '补 ETL 单测',
  project: 'acme-compute',
  state: 'working',
  needsMe: false,
  workerName: 'agentd-w-2',
  openQuestion: null,
}

/** What the recall routes answer, for the tests that read along the chain. */
type Recall = {
  prompt?: string
  links?: Record<number, { follows: unknown; followers: unknown[] }>
  events?: unknown
  transcript?: unknown
  row?: unknown
  found?: unknown[]
}

function fakeDaemon(
  on: On,
  tickets: TicketFixture[],
  activity: () => unknown[] = () => [],
  recall: Recall = {},
) {
  const calls: Call[] = []
  on('http.fetch', (_, e) => {
    const url = new URL(e.url)
    const method = e.init?.method ?? 'GET'
    const body = e.init?.body ? (JSON.parse(e.init.body) as Record<string, unknown>) : undefined
    calls.push({ method, path: `${url.pathname}${url.search}`, body })
    const reply = (data: unknown, status = 200) => ({
      value: { status, ok: status < 300, headers: {}, text: JSON.stringify(data) },
    })
    const path = url.pathname
    if (path === '/status') return reply({ ok: true, lastEventId: 0 })
    if (path === '/events') return reply([])
    if (path === '/activity') return reply(activity())
    if (path === '/tickets' && method === 'GET') return reply(tickets)
    if (path === '/tickets' && method === 'POST') {
      const ticket = {
        ...working,
        id: 3,
        title: body?.title,
        project: body?.project,
        cwd: '/r/memos',
        state: 'queued',
      }
      const note = body?.project === 'chatbox' ? { note: '配置为 MR 项目，但……' } : {}
      return reply({ ok: true, ticket, ...note }, 201)
    }
    if (/^\/tickets\/\d+\/answer$/.test(path)) {
      // As the daemon: only a permission hook fetches its answer; an ask is sent.
      const t = tickets.find(x => `/tickets/${String(x.id)}/answer` === path)
      const q = t?.openQuestion as { kind?: string } | null | undefined
      return reply({
        ok: true,
        questionId: 7,
        hadWaiter: q?.kind === 'permission',
        workerName: t?.workerName,
      })
    }
    if (path === '/tickets/search') return reply(recall.found ?? [])
    if (/^\/tickets\/\d+$/.test(path) && method === 'GET') {
      const t = tickets.find(x => `/tickets/${String(x.id)}` === path)
      const links = t ? recall.links?.[t.id as number] : undefined
      return t
        ? reply({ ...t, prompt: recall.prompt ?? '原任务', ...links })
        : reply({ ok: false, reason: '没有' }, 404)
    }
    if (/^\/tickets\/\d+\/events$/.test(path)) return reply(recall.events ?? [])
    if (/^\/tickets\/\d+\/transcript\/\d+$/.test(path)) return reply(recall.row ?? {})
    if (/^\/tickets\/\d+\/transcript$/.test(path)) return reply(recall.transcript ?? [])
    if (/^\/tickets\/\d+\/(message|say)$/.test(path)) return reply({ ok: true, ticket: working })
    if (/^\/tickets\/\d+\/(retry|resume|stop|close|open_mr|open_mr\/undo)$/.test(path)) {
      return reply({ ok: true, ticket: working })
    }
    return reply({ ok: false, reason: `no route ${method} ${path}` }, 404)
  })
  return calls
}

/** The engine's side of a session in the Router's folder (or elsewhere). */
function engine(on: On, isRouter = true) {
  const registered: string[] = []
  const submitted: string[] = []
  on('session.cwd', () => ({ value: '/router' }))
  on('fs.exists', (_, e) => ({
    value:
      isRouter && (e.path === '/router/.agentd-router' || e.path.endsWith('/daemon/agentd.mjs')),
  }))
  on('tool.register', (_, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__agentd-router__${e.name}` } }
  })
  on('command.register', (_, e) => {
    registered.push(`/${e.name}`)
    return { value: { command: e.name } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })
  // The main conversation as the Router wrote it, and the lines logged to it.
  const transcript: { role: 'user' | 'assistant'; text: string; toolUses: [] }[] = []
  const logged: string[] = []
  on('session.messages', () => ({ value: transcript }))
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  mock.env(on, { HOME: '/home/u' })
  const clock = mock.clock(on)
  return Object.assign(registered, { clock, submitted, transcript, logged })
}

const start = ($: {
  session: {
    start: (e: { cwd: string; surface: 'vscode'; isInteractive: boolean }) => Promise<unknown>
  }
}) => $.session.start({ cwd: '/router', surface: 'vscode', isInteractive: true })

const PRESENTATION = { isFullscreen: false, columns: 120 }
const run = (
  $: {
    command: {
      run: (e: {
        command: string
        args: string
        origin: { kind: 'composer' }
        presentation: typeof PRESENTATION
      }) => Promise<{ text?: string }>
    }
  },
  command: string,
  args = '',
) => $.command.run({ command, args, origin: { kind: 'composer' }, presentation: PRESENTATION })
const say = (
  $: {
    prompt: {
      submit: (e: {
        text: string
        wait: boolean
        origin: { kind: 'composer' }
      }) => Promise<{ drop?: string; context?: readonly string[] }>
    }
  },
  text: string,
) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const BAND = {
  plugin: 'agentd-router',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'agentd-router',
  component: 'Pane',
  requestId: 'agentd-tickets',
  props: {
    title: 'agentd 奏折',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('outside the Router folder the mod registers nothing', async ($, on) => {
  const registered = engine(on, false)
  fakeDaemon(on, [])
  await start($)
  expect(registered).toEqual([])
})

test('the Router registers its tools and commands', async ($, on) => {
  const registered = engine(on)
  fakeDaemon(on, [])
  await start($)
  expect(registered).toEqual(
    expect.arrayContaining([
      'dispatch',
      'status',
      'read',
      'find',
      'answer',
      'message',
      'close',
      'open_mr',
      'stop',
      'resume',
      '/next',
      '/r',
      '/tickets',
    ]),
  )
})

test('the band names the chatted ticket, keeps the Router counts, and says the words go straight to its Worker', async ($, on) => {
  engine(on)
  fakeDaemon(on, [asking, working])
  await start($)
  for (const surface of ['vscode', 'terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text' }))?.text).toMatch(/对 Router 说 · 待处理 1 · 进行中 1/)
    await ui.unmount()
  }
  const next = await run($, 'next')
  expect(next.text).toContain('#1 · acme-flutter · 修复列表滚动掉帧')
  expect(next.text).toContain('A. 可以')
  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(
    /^▶ 单聊 #1 · acme-flutter · 修复列表滚动掉帧 · 它在等你回答\n▶ Router 待处理 1 · 进行中 1 · 你的话直接发给它/,
  )
  await ui.unmount()
})

test('the band is filled with the colour of its mode', async ($, on) => {
  engine(on)
  fakeDaemon(on, [asking, working])
  await start($)
  const fill = async (): Promise<unknown> => {
    const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
    const box = await ui.find({ type: 'Box' })
    await ui.unmount()
    return box?.props.backgroundColor
  }
  // Something waits for the person: yellow.
  expect(await fill()).toBe('warning')
  // A chat, with a question or without: orange, the words go to its Worker.
  await run($, 'next')
  expect(await fill()).toBe('claude')
  await run($, 'ticket', '2')
  expect(await fill()).toBe('claude')
})

test('the band is green when nothing waits for the person', async ($, on) => {
  engine(on)
  fakeDaemon(on, [working])
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect((await ui.find({ type: 'Box' }))?.props.backgroundColor).toBe('success')
  await ui.unmount()
})

test('in a chat with a question, the words are the answer and never reach the Router', async ($, on) => {
  engine(on)
  const calls = fakeDaemon(on, [asking, working])
  const session = mock.session(on)
  const sends: { to: string; text: string }[] = []
  on('session.send', (_, e) => {
    sends.push({ to: e.to, text: e.text })
    return { isDelivered: true as const }
  })
  await start($)
  await run($, 'next')
  const r = await say($, '可以，但写个 TODO')
  expect(r.drop).toContain('已直接发给 #1')
  expect(calls.find(c => c.path === '/tickets/1/answer')?.body).toEqual({
    answer: '可以，但写个 TODO',
  })
  // Its Worker did not wait on the question, so the answer reaches it as a message.
  expect(sends).toEqual([
    {
      to: 'agentd-w-1',
      text: '【agentd ticket #1 回答】你问的「固定行高可以吗？」，用户的回答：可以，但写个 TODO',
    },
  ])
  const note = session.appended().at(-1)
  expect(JSON.stringify(note?.message.content)).toContain('用户已直接回答 #1')
  // The person opened this chat, so it outlives the answer.
  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(/^▶ 单聊 #1/)
  await ui.unmount()
})

test('in a chat without a question, the band keeps the Router counts, and the words are more to do for its Worker', async ($, on) => {
  engine(on)
  const calls = fakeDaemon(on, [working])
  const session = mock.session(on)
  let isDelivered = true
  on('session.send', () =>
    isDelivered
      ? { isDelivered: true as const }
      : { isDelivered: false as const, reason: 'no such session' },
  )
  await start($)
  await run($, 'ticket', '2')
  // The chat keeps the Router's counts in sight, ahead of the hints.
  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(
    /^▶ 单聊 #2 · [^\n]*）\n▶ Router 待处理 0 · 进行中 1 · 你的话直接发给它/,
  )
  await ui.unmount()
  const r = await say($, '再加个空表的用例')
  expect(r.drop).toContain('已直接发给 #2')
  expect(calls.find(c => c.path === '/tickets/2/message')?.body).toEqual({
    text: '再加个空表的用例',
  })
  expect(JSON.stringify(session.appended().at(-1)?.message.content)).toContain(
    '用户直接对 #2 · acme-compute · 补 ETL 单测 的 Worker 说：再加个空表的用例',
  )
  // Words its Worker never got go to the Router, which is told why.
  isDelivered = false
  const missed = await say($, '还有一个')
  expect(missed.drop).toBeUndefined()
  expect((missed.context ?? []).join('\n')).toContain('没能直接发给它的 Worker（没送到 Worker')
  expect(calls.filter(c => c.path === '/tickets/2/message')).toHaveLength(1)
})

test("in a chat with a blocked ticket, the person's words resume its Worker; the Router's never do", async ($, on) => {
  engine(on)
  const blocked = { ...working, state: 'blocked', needsMe: true }
  const calls = fakeDaemon(on, [blocked])
  const sends: string[] = []
  on('session.send', (_, e) => {
    sends.push(e.text)
    return { isDelivered: true as const }
  })
  await start($)
  await run($, 'ticket', '2')
  const r = await say($, '批准提交并开 MR')
  expect(r.drop).toContain('已直接发给 #2')
  expect(calls.find(c => c.path === '/tickets/2/say')?.body).toEqual({ text: '批准提交并开 MR' })
  expect(sends).toEqual([])
  // The Router relaying the same words is a peer message, not the person.
  await $.tool.call({ tool: 'mcp__agentd-router__message', ticket: 2, text: '批准' })
  expect(calls.filter(c => c.path === '/tickets/2/say')).toHaveLength(1)
  expect(sends).toHaveLength(1)
})

test('out of a chat, the words go to the Router with the overview', async ($, on) => {
  engine(on)
  fakeDaemon(on, [working])
  await start($)
  await run($, 'ticket', '2')
  await run($, 'router')
  const r = await say($, '它进展如何')
  expect(r.drop).toBeUndefined()
  const context = (r.context ?? []).join('\n')
  expect(context).toContain('ticket 总览')
  expect(context).toContain('#2 · acme-compute · 补 ETL 单测（在干）')
})

test('after a compaction, the next words carry a fresh overview', async ($, on) => {
  engine(on)
  const told: (string | undefined)[] = []
  on('session.compact', (_, e) => {
    told.push(e.instructions)
    return { messages: e.messages }
  })
  fakeDaemon(on, [working])
  await start($)
  const overviewIn = async (text: string): Promise<boolean> =>
    ((await say($, text)).context ?? []).join('\n').includes('当前 ticket 总览')
  expect(await overviewIn('在吗')).toBe(true)
  expect(await overviewIn('还在吗')).toBe(false)
  const summary = { role: 'user' as const, text: '摘要', toolUses: [] }
  await $.session.compact({ trigger: 'manual', messages: [summary], instructions: '保留计划' })
  expect(told.at(-1)).toContain('保留计划')
  expect(told.at(-1)).toContain('所有仍未结束的 ticket 号')
  expect(await overviewIn('压缩后')).toBe(true)
  expect(await overviewIn('再一句')).toBe(false)
})

test('the Router may not run commands, edit files, or read code', async ($, on) => {
  engine(on)
  fakeDaemon(on, [])
  await start($)
  const denied = async (call: Parameters<typeof $.tool.call>[0]): Promise<void> => {
    const r = await $.tool.call(call)
    expect(r.isError ?? r.deny !== undefined).toBeTruthy()
    expect(String(r.text ?? r.deny)).toContain('Router 不直接干活')
  }
  await denied({ tool: 'Bash', command: 'ls' })
  await denied({ tool: 'Read', file_path: '/r/memos/a.ts' })
  await denied({ tool: 'WebFetch', url: 'https://example.com', prompt: 'x' })
})

test('message reaches the Worker before the ticket moves; an undelivered one moves nothing', async ($, on) => {
  engine(on)
  const calls = fakeDaemon(on, [working])
  let isDelivered = false
  on('session.send', () =>
    isDelivered
      ? { isDelivered: true as const }
      : { isDelivered: false as const, reason: 'no such session' },
  )
  await start($)
  const failed = await $.tool.call({ tool: 'mcp__agentd-router__message', ticket: 2, text: '改' })
  expect(String(failed.deny ?? failed.text)).toContain('没送到 Worker')
  expect(calls.some(c => c.path === '/tickets/2/message')).toBe(false)
  isDelivered = true
  await $.tool.call({ tool: 'mcp__agentd-router__message', ticket: 2, text: '改' })
  expect(calls.find(c => c.path === '/tickets/2/message')?.body).toEqual({ text: '改' })
})

test('a Worker with an open question still takes more to do; one held for a permission does not', async ($, on) => {
  engine(on)
  const permission = {
    ...asking,
    id: 4,
    workerName: 'agentd-w-4',
    openQuestion: {
      id: 9,
      kind: 'permission',
      question: '要跑 git commit',
      options: ['批准', '拒绝'],
    },
  }
  const calls = fakeDaemon(on, [asking, permission])
  const sends: string[] = []
  on('session.send', (_, e) => {
    sends.push(e.text)
    return { isDelivered: true as const }
  })
  await start($)
  const r = await $.tool.call({
    tool: 'mcp__agentd-router__message',
    ticket: 1,
    text: '顺便看下横屏',
  })
  expect(String(r.result)).toContain('已转给 #1')
  expect(sends).toEqual(['【agentd ticket #1 追加指令】顺便看下横屏'])
  expect(calls.find(c => c.path === '/tickets/1/message')?.body).toEqual({ text: '顺便看下横屏' })
  const held = await $.tool.call({ tool: 'mcp__agentd-router__message', ticket: 4, text: '改' })
  expect(String(held.deny ?? held.text ?? held.result)).toContain('在等权限审批')
  expect(sends).toHaveLength(1)
})

test('an answer is sent to its Worker; one that cannot be sent says so, a permission one is never sent', async ($, on) => {
  engine(on)
  const permission = {
    ...asking,
    id: 4,
    workerName: 'agentd-w-4',
    openQuestion: {
      id: 9,
      kind: 'permission',
      question: '要跑 git commit',
      options: ['批准', '拒绝'],
    },
  }
  const calls = fakeDaemon(on, [asking, permission])
  const sends: string[] = []
  on('session.send', (_, e) => {
    sends.push(e.to)
    return { isDelivered: false as const, reason: 'no such session' }
  })
  await start($)
  const missed = await $.tool.call({
    tool: 'mcp__agentd-router__answer',
    ticket: 1,
    answer: '可以',
  })
  expect(String(missed.deny ?? missed.text ?? missed.result)).toContain(
    '回答已记下，但没送到 #1 · acme-flutter · 修复列表滚动掉帧 的 Worker：no such session',
  )
  expect(calls.filter(c => c.path === '/tickets/1/answer')).toHaveLength(1)
  // The hook waiting on a permission question fetches the answer itself.
  const approved = await $.tool.call({
    tool: 'mcp__agentd-router__answer',
    ticket: 4,
    answer: '批准',
  })
  expect(String(approved.result)).toContain('已送达 #4')
  expect(sends).toEqual(['agentd-w-1'])
})

test('dispatch posts the ticket and answers with its header', async ($, on) => {
  engine(on)
  const calls = fakeDaemon(on, [])
  await start($)
  const r = await $.tool.call({
    tool: 'mcp__agentd-router__dispatch',
    project: 'memos',
    title: '加搜索框',
    prompt: '给列表加搜索框',
  })
  expect(String(r.result)).toContain('#3 · memos · 加搜索框 已派出')
  expect(calls.find(c => c.method === 'POST' && c.path === '/tickets')?.body).toMatchObject({
    project: 'memos',
    readonly: false,
  })
})

test('a project set to mr that took the ticket in its folder: the Router is told why', async ($, on) => {
  engine(on)
  fakeDaemon(on, [])
  await start($)
  const r = await $.tool.call({
    tool: 'mcp__agentd-router__dispatch',
    project: 'chatbox',
    title: '改',
    prompt: 'p',
  })
  expect(String(r.result)).toContain('已派出（/r/memos）。配置为 MR 项目，但……。')
})

/** An MR ticket handed back for review. */
const review: TicketFixture = {
  ...working,
  id: 4,
  title: '用户资源自动发布',
  project: 'acme',
  state: 'ready',
  needsMe: true,
  workerName: 'agentd-w-4',
  worktree: true,
  branch: 'agentd/4-abc',
  mrOpened: false,
  lastReport: '改好了，pnpm test 通过',
}

test('an MR ticket under review: 开 MR is recorded first, then told to its Worker; no plain 收', async ($, on) => {
  engine(on)
  const calls = fakeDaemon(on, [review])
  const sends: { to: string; text: string }[] = []
  let wasRecorded = false
  on('session.send', (_, e) => {
    // The Worker checks the record (mr_consent) on these words: it must be there.
    wasRecorded = calls.some(c => c.path === '/tickets/4/open_mr')
    sends.push({ to: e.to, text: e.text })
    return { isDelivered: true as const }
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /待审/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /agentd\/4-abc/ })).toBeDefined()
  expect(await ui.find({ key: 'close-4' })).toBeUndefined()
  await ui.press({ key: 'mr-4' })
  expect(sends).toEqual([{ to: 'agentd-w-4', text: openMrMessage(4, 'agentd/4-abc') }])
  expect(wasRecorded).toBe(true)
  expect(calls.some(c => c.path === '/tickets/4/open_mr/undo')).toBe(false)
  await ui.unmount()
})

test('what the person said with their yes rides on 开 MR, not on a separate message', async ($, on) => {
  engine(on)
  const calls = fakeDaemon(on, [review])
  const sends: { to: string; text: string }[] = []
  on('session.send', (_, e) => {
    sends.push({ to: e.to, text: e.text })
    return { isDelivered: true as const }
  })
  await start($)
  const r = await $.tool.call({
    tool: 'mcp__agentd-router__open_mr',
    ticket: 4,
    text: '先在 k8s-0 验证',
  })
  expect(r.deny).toBeUndefined()
  expect(sends).toEqual([
    { to: 'agentd-w-4', text: openMrMessage(4, 'agentd/4-abc', '先在 k8s-0 验证') },
  ])
  expect(sends[0]?.text).toContain('先在 k8s-0 验证')
  expect(calls.some(c => c.path === '/tickets/4/open_mr')).toBe(true)
  expect(calls.some(c => c.path === '/tickets/4/message')).toBe(false)
})

test('the Router is told an MR is approved with open_mr, never with message', () => {
  expect(ROUTER_PROMPT).toContain('写进 open_mr 的 text')
  expect(ROUTER_PROMPT).toContain('不要改用 message')
})

test('an undelivered 开 MR is taken back: the ticket waits for review again', async ($, on) => {
  engine(on)
  const calls = fakeDaemon(on, [review])
  on('session.send', () => ({ isDelivered: false as const, reason: 'no such session' }))
  await start($)
  const r = await $.tool.call({ tool: 'mcp__agentd-router__open_mr', ticket: 4 })
  expect(String(r.deny)).toContain('没送到')
  expect(String(r.deny)).toContain('开 MR 已撤回')
  const paths = calls.map(c => c.path)
  expect(paths.indexOf('/tickets/4/open_mr/undo')).toBeGreaterThan(
    paths.indexOf('/tickets/4/open_mr'),
  )
})

test('giving an MR ticket up asks once more, then closes it with discard', async ($, on) => {
  engine(on)
  const calls = fakeDaemon(on, [review])
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press(link('discard-4'))
  expect((await ui.find({ key: 'discard-4' }))?.text).toBe(linked('确认放弃', 'discard-4'))
  expect(await ui.find({ type: 'Text', text: /会删掉 worktree 和分支/ })).toBeDefined()
  expect(calls.some(c => c.path === '/tickets/4/close')).toBe(false)
  await ui.press(link('discard-4'))
  expect(calls.find(c => c.path === '/tickets/4/close')?.body).toEqual({ discard: true })
  await ui.unmount()
})

test('an MR ticket reads by its phase; the overview tags readonly and MR tickets', () => {
  expect(phaseWord({ state: 'ready', worktree: true, mrOpened: false })).toBe('待审')
  expect(phaseWord({ state: 'working', worktree: true, mrOpened: true })).toBe('MR 中')
  expect(phaseWord({ state: 'working', worktree: true, mrOpened: false })).toBe('在干')
  expect(phaseWord({ state: 'ready' })).toBe('就绪')
  const lite = (t: TicketFixture) => ({ ...t, question: null, options: null }) as never
  const text = overview([lite(review), lite({ ...working, readonly: true })])
  expect(text).toContain('#4 · acme · 用户资源自动发布（待审 · MR）')
  expect(text).toContain('（在干 · 只读）')
})

test('the pane groups tickets by who they wait for, on every surface that docks it', async ($, on) => {
  engine(on)
  const report = `## 改了什么\n- 给 \`load()\` 补了空表用例\n- ${'很长的一句说明，'.repeat(20)}\n\n跑 \`pnpm test\` 验证。`
  fakeDaemon(on, [asking, { ...working, lastReport: report }])
  await start($)
  for (const surface of ['vscode', 'desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /待我处理/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /进行中/ })).toBeDefined()
    // Each ticket: its number on a badge, its project on a tag of its own color.
    expect(await ui.find({ type: 'Text', text: ' #1 ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' acme-flutter ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /它在问你/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: '固定行高可以吗？' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /可选：可以 · 用 prototypeItem/ })).toBeDefined()
    // The whole report, as markdown to draw, not one cut line.
    expect(await ui.find({ type: 'Markdown', text: report })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '最近消息' })).toBeDefined()
    expect(await ui.find({ key: 'open-1' })).toBeDefined()
    await ui.press({ key: 'chat-2' })
    expect((await ui.find({ key: 'chat-2' }))?.text).toBe('单聊中')
    await ui.press({ key: 'chat-2' })
    expect((await ui.find({ key: 'chat-2' }))?.text).toBe('单聊')
    await ui.unmount()
  }
})

test('the chat button logs one short line saying how far up the Router spoke of it; leaving says where the words go', async ($, on) => {
  const { transcript, logged } = engine(on)
  fakeDaemon(on, [asking, working])
  transcript.push(
    { role: 'assistant', text: '#2 · acme-compute · 补 ETL 单测：开始跑了。', toolUses: [] },
    { role: 'assistant', text: '#1 · acme-flutter · 修复列表滚动掉帧：在问你。', toolUses: [] },
  )
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'chat-2' })
  expect(logged.at(-1)).toBe(
    '▶ 单聊 #2 · acme-compute · 补 ETL 单测（在干）：往上数第 2 条 Router 回复讲到它，那一段已框成橙色并标「▶ 单聊中」；你的话直接发给它的 Worker。',
  )
  // The card stays in the Pane: none of it is copied into the line.
  expect(logged.at(-1)).not.toContain('定位到 itemExtent')
  await ui.press({ key: 'chat-2' })
  expect(logged.at(-1)).toBe('已结束单聊，你的话回到 Router。')
  await ui.unmount()
})

test('mentionDepth counts Router replies with words up to the one about the ticket, and chatNote says so', () => {
  const messages = [
    { role: 'assistant', text: '#2 · p · t：开始跑了。' },
    { role: 'user', text: '#2 · p · t：用户的话不算' },
    { role: 'assistant', text: '两件事：\n\n#1 · q · u：在问你。' },
    { role: 'assistant', text: '' },
    { role: 'assistant', text: '好的。' },
  ]
  expect(mentionDepth(messages, 1)).toBe(2)
  expect(mentionDepth(messages, 2)).toBe(3)
  expect(mentionDepth(messages, 9)).toBeNull()
  const t = lite(working as never)
  expect(chatNote(t, 1)).toContain('Router 最近一条回复讲到它')
  expect(chatNote(t, null)).toContain('Router 还没讲过它')
})

test('the replies speaking of the ticket in a chat are framed orange and marked, and go back when it ends', async ($, on) => {
  engine(on)
  fakeDaemon(on, [asking, working])
  await start($)
  const reply = async () => {
    const ui = await $.ui.mount({
      plugin: 'agentd-router',
      component: 'AssistantMessage',
      props: {
        text: '#1 · acme-flutter · 修复列表滚动掉帧：在问你。\n\n#2 · acme-compute · 补 ETL 单测：在跑。',
        isFirstOfReply: true,
      },
      surface: 'vscode',
    })
    const frames = (await ui.findAll({ type: 'Box' })).filter(b => b.props.borderStyle === 'round')
    const marks = (await ui.findAll({ type: 'Text', text: '▶ 单聊中' })).length
    await ui.unmount()
    return { colours: frames.map(b => b.props.borderColor), marks }
  }
  expect(await reply()).toEqual({ colours: ['warning', 'suggestion'], marks: 0 })
  const pane = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await pane.press({ key: 'chat-2' })
  expect(await reply()).toEqual({ colours: ['warning', 'claude'], marks: 1 })
  await pane.press({ key: 'chat-2' })
  expect(await reply()).toEqual({ colours: ['warning', 'suggestion'], marks: 0 })
  await pane.unmount()
})

test('read summary gives the latest message, and not again when it is the open question', async ($, on) => {
  engine(on)
  const question = '**权限请求**：Worker 想用 `Bash` 做这件事——'
  fakeDaemon(on, [
    {
      ...asking,
      lastReport: question,
      openQuestion: { id: 7, kind: 'permission', question, options: null },
    },
    { ...working, lastReport: '改完一处，pnpm test 通过' },
  ])
  await start($)
  const summary = async (ticket: number): Promise<string> =>
    String(
      (await $.tool.call({ tool: 'mcp__agentd-router__read', ticket, what: 'summary' })).result,
    )
  const one = await summary(1)
  expect(one).toContain(`待答问题：${question}`)
  expect(one).not.toContain('最近消息')
  const two = await summary(2)
  expect(two).toContain('最近消息：改完一处，pnpm test 通过')
  expect(two).not.toContain('最近汇报')
})

test("an answered question shows the person's answer under it, on the card and in read", async ($, on) => {
  engine(on)
  const question = '**权限请求**：Worker 想用 `Bash` 做这件事——'
  fakeDaemon(on, [
    { ...working, lastReport: question, lastAnswer: '批准' },
    { ...working, id: 3, lastReport: '改完一处' },
  ])
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Markdown', text: question })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '你答：批准' })).toBeDefined()
  // Only the answered card carries an answer.
  expect(await ui.findAll({ type: 'Text', text: /^你答：/ })).toHaveLength(1)
  await ui.unmount()
  const summary = async (ticket: number): Promise<string> =>
    String(
      (await $.tool.call({ tool: 'mcp__agentd-router__read', ticket, what: 'summary' })).result,
    )
  expect(await summary(2)).toContain(`最近消息：${question}\n你答：批准`)
  expect(await summary(3)).not.toContain('你答')
})

test("a working card shows its Worker's last two lines and how long ago it moved", async ($, on) => {
  const { clock } = engine(on)
  let at = 0
  const calls = fakeDaemon(on, [asking, working], () => [
    { ticketId: 2, lines: ['▸ Bash Run the tests', '测试全部通过'], at },
  ])
  await start($)
  at = clock.now() - 12_000
  await clock.advance(2_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: '▸ Bash Run the tests' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '测试全部通过' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /● 最近动作 14 秒前/ })).toBeDefined()
  // Labelled apart from the whole message, and drawn below it.
  const texts = (await ui.findAll({ type: 'Text' })).map(n => n.text)
  expect(texts.indexOf('最近消息')).toBeGreaterThan(-1)
  expect(texts.indexOf('实时动作')).toBeGreaterThan(texts.indexOf('最近消息'))
  // Silent for minutes: the card says so, in the warning colour.
  at = clock.now() - 6 * 60_000
  await clock.advance(10_000)
  const quiet = await ui.find({ type: 'Text', text: /已 6 分钟没有新动作/ })
  expect(quiet?.props.color).toBe('warning')
  await ui.unmount()
  // Only polled while something is working.
  expect(calls.some(c => c.path === '/activity')).toBe(true)
})

test('进行中 folds to two lines a ticket in 极简显示, with the age of its last move, and back', async ($, on) => {
  const { clock } = engine(on)
  let at = 0
  fakeDaemon(on, [asking, { ...working, lastReport: '改完一处' }], () => [
    { ticketId: 2, lines: ['▸ Bash Run the tests'], at },
  ])
  await start($)
  at = clock.now() - 12_000
  await clock.advance(2_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  // Whole by default: a framed card with its message and live lines.
  expect((await ui.find({ key: 'working-view' }))?.text).toBe(linked('极简显示', 'working-view'))
  expect((await ui.find({ key: 't-2' }))?.props.borderStyle).toBe('round')
  await ui.press(link('working-view'))
  // Brief: no frame, no message, no live lines; the age stays, under the head.
  expect((await ui.find({ key: 't-2' }))?.props.borderStyle).toBeUndefined()
  expect(await ui.find({ type: 'Markdown', text: '改完一处' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '▸ Bash Run the tests' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /● 最近动作 14 秒前/ })).toBeDefined()
  expect(await ui.find({ key: 'stop-2' })).toBeUndefined()
  // A card that needs the person stays whole: only 进行中 is brief.
  expect((await ui.find({ key: 't-1' }))?.props.borderStyle).toBe('round')
  // The way in stays a link on the head's second line.
  // Its dot rides with it, so a wrapped line never starts on a bare link.
  expect(await ui.find({ key: 'chat-2-dot' })).toBeDefined()
  await ui.press(link('chat-2'))
  expect((await ui.find({ key: 'chat-2' }))?.text).toBe(linked('单聊中', 'chat-2'))
  // Kept over a reload; pressed again, whole again.
  await start($)
  expect((await ui.find({ key: 't-2' }))?.props.borderStyle).toBeUndefined()
  await ui.press(link('working-view'))
  expect((await ui.find({ key: 't-2' }))?.props.borderStyle).toBe('round')
  await ui.unmount()
})

test('no row in the Pane spaces with gap, which would part its wrapped lines a row in VS Code', async ($, on) => {
  engine(on)
  const stopped = { ...working, id: 8, state: 'stopped', needsMe: false, workerBgId: 'bg8' }
  fakeDaemon(on, [asking, working, review, { ...permit, id: 5 }, stopped])
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const rows = (await ui.findAll({ type: 'Box' })).filter(b => b.props.flexDirection === 'row')
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.filter(b => b.props.gap !== undefined)).toEqual([])
  await ui.press(link('working-view'))
  const brief = (await ui.findAll({ type: 'Box' })).filter(b => b.props.flexDirection === 'row')
  expect(brief.filter(b => b.props.gap !== undefined)).toEqual([])
  await ui.unmount()
})

test('no Worker is working: activity is never asked for', async ($, on) => {
  const { clock } = engine(on)
  const calls = fakeDaemon(on, [asking])
  await start($)
  await clock.advance(10_000)
  expect(calls.some(c => c.path === '/activity')).toBe(false)
})

const permit: TicketFixture = {
  ...asking,
  id: 4,
  title: '提交改动',
  openQuestion: {
    id: 9,
    question: '**权限请求**\n\n```\ngit commit -m x\n```\n\n批准这一次吗？',
    options: ['批准', '拒绝'],
    kind: 'permission',
  },
}

test('a permission request is approved from the pane, and the Router keeps a line of it', async ($, on) => {
  engine(on)
  const calls = fakeDaemon(on, [permit])
  const session = mock.session(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await start($)
  expect((await run($, 'ticket', '4')).text).toContain('输入「批准」放行这一次')
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /它要权限/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /可选：/ })).toBeUndefined()
  expect(await ui.find({ key: 'reject-4' })).toBeDefined()
  await ui.press({ key: 'approve-4' })
  expect(calls.find(c => c.path === '/tickets/4/answer')?.body).toEqual({ answer: '批准' })
  expect(JSON.stringify(session.appended().at(-1)?.message.content)).toContain(
    '用户在面板上批准了 #4',
  )
  expect(toasts.at(-1)).toContain('已批准 #4')
  await ui.unmount()
})

test('a plain question shows no approve buttons', async ($, on) => {
  engine(on)
  fakeDaemon(on, [asking])
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ key: 'approve-1' })).toBeUndefined()
  await ui.unmount()
})

test('a blocked ticket with a Worker is retried on its own conversation', async ($, on) => {
  engine(on)
  const blocked = { ...working, id: 5, state: 'blocked', needsMe: true }
  const lost = { ...working, id: 6, state: 'failed', needsMe: true, workerSessionId: null }
  const calls = fakeDaemon(on, [blocked, lost])
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  // A Worker with no conversation to resume has nothing to retry on.
  expect(await ui.find({ key: 'retry-6' })).toBeUndefined()
  await ui.press({ key: 'retry-5' })
  expect(calls.some(c => c.method === 'POST' && c.path === '/tickets/5/retry')).toBe(true)
  expect(toasts.at(-1)).toContain('接着原会话重启')
  await ui.unmount()
})

test('a stopped ticket can be resumed from the Pane; a closed one cannot', async ($, on) => {
  engine(on)
  const stopped = { ...working, id: 8, state: 'stopped', needsMe: false, workerBgId: 'bg8' }
  const closed = { ...working, id: 9, state: 'done', needsMe: false, workerBgId: 'bg9' }
  const calls = fakeDaemon(on, [stopped, closed])
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ key: 'resume-9' })).toBeUndefined()
  expect(await ui.find({ key: 'retry-8' })).toBeUndefined()
  await ui.press({ key: 'resume-8' })
  expect(calls.some(c => c.method === 'POST' && c.path === '/tickets/8/resume')).toBe(true)
  expect(toasts.at(-1)).toContain('接着原会话恢复')
  await ui.unmount()
})

test('a message to a stopped ticket says to resume it, and sends nothing', async ($, on) => {
  engine(on)
  const stopped = { ...working, state: 'stopped', needsMe: false, workerBgId: 'bg2' }
  const calls = fakeDaemon(on, [stopped])
  const sends: string[] = []
  on('session.send', (_, e) => {
    sends.push(e.text)
    return { isDelivered: true as const }
  })
  await start($)
  const r = await $.tool.call({ tool: 'mcp__agentd-router__message', ticket: 2, text: '继续' })
  expect(String(r.deny ?? r.text)).toContain('先恢复（resume）')
  expect(sends).toEqual([])
  expect(calls.some(c => c.path === '/tickets/2/message')).toBe(false)
})

test('open attaches to a live Worker in iTerm2, and shows an ended one in VS Code', async ($, on) => {
  const { clock } = engine(on)
  const ended = { ...working, id: 8, state: 'done', needsMe: false, workerBgId: 'bg8' }
  fakeDaemon(on, [working, ended])
  const runs: (readonly string[])[] = []
  on('process.run', (_, e) => {
    runs.push(e.argv)
    return {
      value: {
        exitCode: 0,
        stdout: '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.toast', () => ({ value: undefined }))
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'open-2' })
  expect(runs).toEqual([
    [
      'osascript',
      '-e',
      'tell application "iTerm"',
      '-e',
      `create window with default profile command "/bin/zsh -lic 'claude attach bg1'"`,
      '-e',
      'activate',
      '-e',
      'end tell',
    ],
  ])
  const pressed = ui.press(link('open-8'))
  await clock.advance(1_500)
  await pressed
  expect(runs.slice(1)).toEqual([
    ['open', '-a', 'Visual Studio Code', '/r/acme-flutter'],
    ['open', 'vscode://anthropic.claude-code/open?session=sess-1'],
  ])
  expect(runs.filter(a => a[0] === 'osascript')).toHaveLength(1)
  await ui.unmount()
})

test('restart ends a daemon too old to have /shutdown by its pid, then starts the new one', async ($, on) => {
  const { clock } = engine(on)
  let oldPid: number | null = 4242
  const runs: (readonly string[])[] = []
  on('http.fetch', (_, e) => {
    const path = new URL(e.url).pathname
    const reply = (data: unknown, status = 200) => ({
      value: { status, ok: status < 300, headers: {}, text: JSON.stringify(data) },
    })
    if (path === '/status') {
      return oldPid === null
        ? reply({ ok: false, reason: 'down' }, 503)
        : reply({ ok: true, pid: oldPid, lastEventId: 0 })
    }
    if (path === '/tickets' || path === '/events') return reply([])
    return reply({ ok: false, reason: 'no route' }, 404)
  })
  on('process.run', (_, e) => {
    runs.push(e.argv)
    if (e.argv[0] === 'kill') oldPid = null
    if (e.argv.includes('serve')) oldPid = 5151
    const done = { exitCode: 0, stdout: '', stderr: '' }
    return { value: { ...done, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', () => ({ value: undefined }))
  await start($)
  const answered = run($, 'agentd', 'restart')
  await clock.advance(20_000)
  expect((await answered).text).toBe('agentd 已在线。')
  expect(runs[0]).toEqual(['kill', '4242'])
  expect(runs[1]).toContain('serve')
})

test('the pane colors: a state its own, a project always the same', () => {
  expect(stateLook('asking').color).toBe('warning')
  expect(stateLook('ready').glyph).toBe('✓')
  expect(projectColor('acme-flutter')).toBe(projectColor('acme-flutter'))
  const colors = new Set(['memos', 'acme-flutter', 'acme-compute', 'agentd'].map(projectColor))
  expect(colors.size).toBeGreaterThan(1)
  for (const c of colors) expect(c).toMatch(/^#[0-9A-F]{6}$/)
})

test('ages read as a person says them', () => {
  expect(ago(30_000)).toBe('刚刚')
  expect(ago(5 * 60_000)).toBe('5 分钟前')
  expect(ago(3 * 3_600_000)).toBe('3 小时前')
  expect(ago(50 * 3_600_000)).toBe('2 天前')
  expect(seconds(12_400)).toBe('12 秒前')
  expect(seconds(5 * 60_000)).toBe('5 分钟前')
})

test('stop asks once more before it stops a Worker', async ($, on) => {
  engine(on)
  const calls = fakeDaemon(on, [working])
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press(link('stop-2'))
  expect((await ui.find({ key: 'stop-2' }))?.text).toBe(linked('确认停止', 'stop-2'))
  // The cost is said on a line of its own, so the row keeps its width.
  expect(await ui.find({ type: 'Text', text: /再点一次「确认停止」/ })).toBeDefined()
  expect(calls.some(c => c.path === '/tickets/2/stop')).toBe(false)
  await ui.press(link('stop-2'))
  expect(calls.some(c => c.path === '/tickets/2/stop')).toBe(true)
  await ui.unmount()
})

test('events that need the person reach the Router batched, and a question opens a chat that holds the others until it is answered', async ($, on) => {
  const { clock, submitted } = engine(on)
  mock.session(on)
  let feed: unknown[] = [
    {
      id: 5,
      ticketId: 1,
      kind: 'progress',
      summary: '在看',
      isCut: false,
      ticket: { id: 1, title: '修复列表滚动掉帧', project: 'acme-flutter' },
    },
    {
      id: 6,
      ticketId: 1,
      kind: 'ask',
      summary: '固定行高可以吗？ 选项：可以 / 用 prototypeItem',
      isCut: false,
      priorReport: '定位到 itemExtent',
      ticket: { id: 1, title: '修复列表滚动掉帧', project: 'acme-flutter' },
    },
    {
      id: 7,
      ticketId: 2,
      kind: 'ready',
      summary: '单测补完，pnpm test 通过',
      isCut: false,
      ticket: { id: 2, title: '补 ETL 单测', project: 'acme-compute' },
    },
  ]
  on('http.fetch', (_, e) => {
    const path = new URL(e.url).pathname
    const reply = (data: unknown) => ({
      value: { status: 200, ok: true, headers: {}, text: JSON.stringify(data) },
    })
    if (path === '/status') return reply({ ok: true, lastEventId: 4 })
    if (path === '/tickets') return reply([asking, { ...working, state: 'ready', needsMe: true }])
    if (path === '/tickets/1/answer') {
      return reply({ ok: true, questionId: 7, hadWaiter: true, workerName: 'agentd-w-1' })
    }
    if (path === '/events') {
      const out = feed
      feed = []
      return reply(out)
    }
    return reply({})
  })
  await start($)
  await clock.advance(2_000)
  // The feed was read, but the batch waits for the feed to go quiet.
  expect(submitted).toHaveLength(0)
  await clock.advance(2_000)
  // The question opens a chat, and #2's delivery waits until it is answered.
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('[agentd] 1 条新事件')
  expect(submitted[0]).toContain(
    '【#1 · acme-flutter · 修复列表滚动掉帧】Worker 提问：固定行高可以吗？',
  )
  // A question carries where its Worker had got to.
  expect(submitted[0]).toContain(
    '固定行高可以吗？ 选项：可以 / 用 prototypeItem\n  此前进展：定位到 itemExtent',
  )
  expect(submitted[0]).not.toContain('#2 · acme-compute')
  expect(submitted[0]).not.toContain('在看')
  const band = async (): Promise<string | undefined> => {
    const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
    const text = (await ui.find({ type: 'Text' }))?.text
    await ui.unmount()
    return text
  }
  expect(await band()).toMatch(/^▶ 单聊 #1/)
  // The question opened this chat, so the answer ends it: what comes next is for the Router.
  expect((await say($, '可以')).drop).toContain('已直接发给 #1')
  expect(await band()).toMatch(/^▶ 对 Router 说/)
  // The delivery that waited reaches it now; a finished one needs no context.
  await clock.advance(2_000)
  expect(submitted).toHaveLength(2)
  expect(submitted[1]).toContain('【#2 · acme-compute · 补 ETL 单测】已就绪，待验收')
  expect(submitted[1]).not.toContain('此前进展')
})

test('a command name the engine refuses does not stop the Router from starting', async ($, on) => {
  const registered: string[] = []
  on('session.cwd', () => ({ value: '/router' }))
  on('fs.exists', (_, e) => ({ value: e.path === '/router/.agentd-router' }))
  on('tool.register', (_, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__agentd-router__${e.name}` } }
  })
  on('command.register', (_, e) => {
    if (e.name === 'next') throw new Error('"/next" refused: it is the built-in /next')
    registered.push(`/${e.name}`)
    return { value: { command: e.name } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  mock.env(on, { HOME: '/home/u' })
  mock.clock(on)
  fakeDaemon(on, [working])
  await start($)
  expect(registered).toEqual(expect.arrayContaining(['dispatch', '/ticket', '/tickets', '/agentd']))
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /进行中/ })).toBeDefined()
  await ui.unmount()
})

test('while one question is answered every other ticket waits its turn; questions take the chat one after another', async ($, on) => {
  const { clock, submitted } = engine(on)
  mock.session(on)
  on('session.send', () => ({ isDelivered: true as const }))
  const second: TicketFixture = {
    ...asking,
    id: 2,
    title: '补 ETL 单测',
    project: 'acme-compute',
    workerName: 'agentd-w-2',
    openQuestion: { id: 8, question: '要覆盖 **空表** 吗？', options: null },
    updatedAt: 20,
  }
  const third: TicketFixture = {
    ...working,
    id: 3,
    title: '部署台消息通知',
    project: 'acme-ops',
    state: 'ready',
    needsMe: true,
  }
  let list: TicketFixture[] = [asking, second, third]
  const ask = (id: number, ticket: TicketFixture, summary: string) => ({
    id,
    ticketId: ticket.id,
    kind: 'ask',
    summary,
    isCut: false,
    priorReport: null,
    ticket: { id: ticket.id, title: ticket.title, project: ticket.project },
  })
  let feed: unknown[] = [
    ask(6, asking, '固定行高可以吗？'),
    ask(7, second, '要覆盖空表吗？'),
    { ...ask(8, third, '消息通知已上线'), kind: 'ready' },
  ]
  on('http.fetch', (_, e) => {
    const path = new URL(e.url).pathname
    const reply = (data: unknown) => ({
      value: { status: 200, ok: true, headers: {}, text: JSON.stringify(data) },
    })
    if (path === '/status') return reply({ ok: true, lastEventId: 5 })
    if (path === '/tickets') return reply(list)
    if (path === '/tickets/1/answer') {
      list = [{ ...asking, state: 'working', needsMe: false, openQuestion: null }, second, third]
      return reply({ ok: true, questionId: 7, hadWaiter: false, workerName: 'agentd-w-1' })
    }
    if (path === '/tickets/2/answer') {
      list = [
        list[0] as TicketFixture,
        { ...second, state: 'working', needsMe: false, openQuestion: null },
        third,
      ]
      return reply({ ok: true, questionId: 8, hadWaiter: false, workerName: 'agentd-w-2' })
    }
    if (path === '/events') {
      const out = feed
      feed = []
      return reply(out)
    }
    return reply({})
  })
  const band = async (): Promise<string | undefined> => {
    const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
    const text = (await ui.find({ type: 'Text' }))?.text
    await ui.unmount()
    return text
  }

  await start($)
  await clock.advance(4_000)
  // #1's question opened the chat; #2's question and #3's delivery wait, so the
  // Router tells of #1 alone: a 收了 meant for #3 cannot reach #1's Worker.
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('[agentd] 1 条新事件')
  expect(submitted[0]).toContain('#1 · acme-flutter')
  expect(submitted[0]).not.toContain('#2 · acme-compute')
  expect(submitted[0]).not.toContain('#3 · acme-ops')
  expect(await band()).toMatch(/^▶ 单聊 #1 [^\n]* · 它在等你回答\n▶ Router 待处理 3 · 进行中 0 · /)

  // Answered: the chat passes to #2, the next question, and the Router hears of
  // it; #3's delivery waits on.
  expect((await say($, '可以')).drop).toContain('已直接发给 #1')
  expect(await band()).toMatch(
    /^▶ 单聊 #2 · acme-compute · 补 ETL 单测 · 它在等你回答\n▶ Router 待处理 2 · 进行中 1 · /,
  )
  await clock.advance(2_000)
  expect(submitted).toHaveLength(2)
  expect(submitted[1]).toContain('#2 · acme-compute')
  expect(submitted[1]).not.toContain('#3 · acme-ops')

  // No question is left: the chat ends, and the delivery reaches the Router.
  expect((await say($, '要')).drop).toContain('已直接发给 #2')
  expect(await band()).toMatch(/^▶ 对 Router 说/)
  await clock.advance(2_000)
  expect(submitted).toHaveLength(3)
  expect(submitted[2]).toContain('【#3 · acme-ops · 部署台消息通知】已就绪，待验收')
})

/** A daemon whose tickets and feed a test moves along, one poll at a time. */
function scriptedDaemon(on: On, first: TicketFixture[]) {
  let list = first
  let feed: unknown[] = []
  const calls: string[] = []
  on('http.fetch', (_, e) => {
    const path = new URL(e.url).pathname
    calls.push(path)
    const reply = (data: unknown) => ({
      value: { status: 200, ok: true, headers: {}, text: JSON.stringify(data) },
    })
    if (path === '/status') return reply({ ok: true, lastEventId: 5 })
    if (path === '/tickets') return reply(list)
    if (path === '/events') {
      const out = feed
      feed = []
      return reply(out)
    }
    const closed = /^\/tickets\/(\d+)\/(close|stop)$/.exec(path)
    if (closed) {
      const id = Number(closed[1])
      list = list.filter(t => t.id !== id)
      return reply({ ok: true, ticket: { ...working, id, state: 'done' } })
    }
    return reply({})
  })
  const event = (id: number, ticket: TicketFixture, kind: string, summary: string) => ({
    id,
    ticketId: ticket.id,
    kind,
    summary,
    isCut: false,
    priorReport: null,
    ticket: { id: ticket.id, title: ticket.title, project: ticket.project },
  })
  return {
    calls,
    /** The next poll sees these tickets and these new events. */
    move(tickets: TicketFixture[], events: ReturnType<typeof event>[] = []) {
      list = tickets
      feed = [...feed, ...events]
    },
    event,
  }
}

const bandOf = async ($: {
  ui: {
    mount: (e: typeof BAND & { surface: 'vscode' }) => Promise<{
      find: (q: { type: 'Text' }) => Promise<{ text?: string } | undefined>
      unmount: () => Promise<void>
    }>
  }
}): Promise<string | undefined> => {
  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  const text = (await ui.find({ type: 'Text' }))?.text
  await ui.unmount()
  return text
}

test('a chat the person opened ends once its Worker hands in, and with no question waiting the words go back to the Router', async ($, on) => {
  const { clock, submitted } = engine(on)
  mock.session(on)
  const ready: TicketFixture = { ...working, state: 'ready', needsMe: true, updatedAt: 30 }
  const daemon = scriptedDaemon(on, [working, { ...ready, id: 3, title: '早就交了' }])
  await start($)
  await run($, 'ticket', '3')
  // A chat opened on a ticket that already handed in stays: the person chose it to say more.
  await clock.advance(12_000)
  expect(await bandOf($)).toMatch(/^▶ 单聊 #3/)

  await run($, 'ticket', '2')
  expect(await bandOf($)).toMatch(/^▶ 单聊 #2/)
  daemon.move(
    [ready, { ...ready, id: 3, title: '早就交了' }],
    [daemon.event(6, working, 'ready', '单测补完')],
  )
  await clock.advance(2_000)
  // Its work is in: what the person says next (a 收了) is for the Router.
  expect(await bandOf($)).toMatch(/^▶ 对 Router 说/)
  await clock.advance(2_000)
  expect(submitted.at(-1)).toContain('【#2 · acme-compute · 补 ETL 单测】已就绪，待验收')
})

test('a chat that ends while a question waits passes to that question, whichever way it ended', async ($, on) => {
  const { clock, submitted } = engine(on)
  mock.session(on)
  const later: TicketFixture = {
    ...asking,
    id: 4,
    title: '换图标',
    project: 'memos',
    workerName: 'agentd-w-4',
    openQuestion: { id: 9, question: '用 SVG 吗？', options: null },
    updatedAt: 40,
  }
  const daemon = scriptedDaemon(on, [working, asking, later])
  await start($)
  await run($, 'ticket', '2')
  daemon.move(
    [{ ...working, state: 'ready', needsMe: true }, asking, later],
    [daemon.event(6, working, 'ready', '单测补完')],
  )
  await clock.advance(2_000)
  // Handed in: the chat goes to the question waiting longest, not to the Router.
  expect(await bandOf($)).toMatch(/^▶ 单聊 #1 [^\n]* · 它在等你回答/)
  // The Router tells of the question the chat moved to; #2's delivery waits its turn.
  await clock.advance(2_000)
  expect(submitted.at(-1)).not.toContain('#2 · acme-compute')

  // Closed from the Router: the chat passes on the same way.
  await run($, 'ticket', '2')
  await $.tool.call({ tool: 'mcp__agentd-router__close', ticket: 2 })
  expect(await bandOf($)).toMatch(/^▶ 单聊 #1 [^\n]* · 它在等你回答/)
})

test('a chat stays with a Worker that is blocked or still asks, and /router always goes back to the Router', async ($, on) => {
  const { clock } = engine(on)
  mock.session(on)
  const daemon = scriptedDaemon(on, [working, asking])
  await start($)
  await run($, 'ticket', '2')
  // Blocked: the person approves in the chat, so it stays open.
  daemon.move(
    [{ ...working, state: 'blocked', needsMe: true }, asking],
    [daemon.event(6, working, 'blocked', '要 git commit 的权限')],
  )
  await clock.advance(2_000)
  expect(await bandOf($)).toMatch(/^▶ 单聊 #2/)
  // A Worker that hands in with a question still open (a permission it waits on) keeps the chat.
  await run($, 'ticket', '1')
  daemon.move(
    [
      { ...working, state: 'blocked', needsMe: true },
      { ...asking, state: 'ready' },
    ],
    [daemon.event(7, asking, 'ready', '改完了')],
  )
  await clock.advance(2_000)
  expect(await bandOf($)).toMatch(/^▶ 单聊 #1/)
  // The person leaving the chat goes to the Router, even with a question waiting.
  await run($, 'ticket', '2')
  await run($, 'router')
  expect(await bandOf($)).toMatch(/^▶ 对 Router 说/)
})

test('a Router reply is split into one part per ticket it speaks of', () => {
  const reply = [
    '两份奏折等你：',
    '',
    '#10 · acme-ops · 只读：部署台 webhook：脚本已写好。',
    '**权限请求**',
    '- 命令：执行 patch-webhook-secret.sh',
    '',
    '批准这一次吗？',
    '',
    '**#11 · memos · 补单测**：已就绪，要验收吗？',
  ].join('\n')
  expect(ticketSections(reply)).toEqual({
    lead: '两份奏折等你：',
    sections: [
      {
        id: 10,
        project: 'acme-ops',
        text: '#10 · acme-ops · 只读：部署台 webhook：脚本已写好。\n**权限请求**\n- 命令：执行 patch-webhook-secret.sh\n\n批准这一次吗？',
      },
      { id: 11, project: 'memos', text: '**#11 · memos · 补单测**：已就绪，要验收吗？' },
    ],
  })
  // Numbered, bulleted or made a heading, a header still opens a part; a
  // numbered line that is no header stays inside the part it is in.
  const listed = ticketSections(
    [
      '**1. #10 · acme-ops · 部署台**：生产验证不完整',
      '1. 新 Pod 健康',
      '2. **#11 · acme · 晋级 staging**',
      '- #12 · memos · 补单测：在干',
      '### #13 · agentd · 问题框',
    ].join('\n'),
  )
  expect(listed.sections.map(x => [x.id, x.project])).toEqual([
    [10, 'acme-ops'],
    [11, 'acme'],
    [12, 'memos'],
    [13, 'agentd'],
  ])
  expect(listed.sections[0]?.text).toContain('1. 新 Pod 健康')
  // A reply about no ticket, or one naming a ticket mid-line, is left alone.
  expect(ticketSections('好的，我去派工。顺便 #3 · x · y 也在跑').sections).toEqual([])
})

test('each ticket in a Router reply is drawn in a frame of the colour of its state', async ($, on) => {
  engine(on)
  fakeDaemon(on, [
    { ...asking, id: 10, project: 'acme-ops' },
    { ...working, id: 11, project: 'memos', state: 'ready', needsMe: true },
  ])
  await start($)
  const ui = await $.ui.mount({
    plugin: 'agentd-router',
    component: 'AssistantMessage',
    props: {
      text: '一共三份：\n\n#10 · acme-ops · 部署：批准这一次吗？\n\n#11 · memos · 补单测：要验收吗？\n\n#4 · agentd · 旧活：早已结束。',
      isFirstOfReply: true,
    },
    surface: 'vscode',
  })
  const frames = (await ui.findAll({ type: 'Box' })).filter(b => b.props.borderStyle === 'round')
  // Asking is yellow, ready green, as in the Pane; one no longer listed is grey.
  expect(frames.map(b => b.props.borderColor)).toEqual(['warning', 'success', 'subtle'])
  const texts = (await ui.findAll({ type: 'Markdown' })).map(m => m.props.text)
  expect(texts).toEqual([
    '一共三份：',
    '#10 · acme-ops · 部署：批准这一次吗？',
    '#11 · memos · 补单测：要验收吗？',
    '#4 · agentd · 旧活：早已结束。',
  ])
  await ui.unmount()
})

test('ended tickets page ten at a time, newest number first', () => {
  const ended = Array.from({ length: 23 }, (_, i) => ({ ...working, id: i + 1, state: 'done' }))
  const ids = (page: number) => endedPage(ended as never, page).rows.map(t => t.id)
  expect(ids(0)).toEqual([23, 22, 21, 20, 19, 18, 17, 16, 15, 14])
  expect(ids(2)).toEqual([3, 2, 1])
  expect(endedPage(ended as never, 0).pages).toBe(3)
  // A page past the end, after tickets age out of the day, shows the last.
  expect(endedPage(ended as never, 9).page).toBe(2)
  expect(endedPage([], 0)).toEqual({ rows: [], page: 0, pages: 1 })
})

test('the Pane pages the ended tickets, newest number first', async ($, on) => {
  engine(on)
  const ended = Array.from({ length: 12 }, (_, i) => ({
    ...working,
    id: i + 1,
    state: i % 2 ? 'done' : 'stopped',
    needsMe: false,
    workerSessionId: `sess-${i + 1}`,
  }))
  fakeDaemon(on, [...ended, { ...working, id: 20 }])
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ key: 'open-12' })).toBeDefined()
  expect(await ui.find({ key: 'open-3' })).toBeDefined()
  expect(await ui.find({ key: 'open-2' })).toBeUndefined()
  expect(await ui.find({ key: 'open-20' })).toBeDefined()
  expect(await ui.find({ key: 'ended-prev' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '第 1 / 2 页' })).toBeDefined()
  await ui.press({ key: 'ended-next' })
  expect(await ui.find({ key: 'open-2' })).toBeDefined()
  expect(await ui.find({ key: 'open-1' })).toBeDefined()
  expect(await ui.find({ key: 'open-3' })).toBeUndefined()
  expect(await ui.find({ key: 'ended-next' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '第 2 / 2 页' })).toBeDefined()
  await ui.press({ key: 'ended-prev' })
  expect(await ui.find({ key: 'open-12' })).toBeDefined()
  await ui.unmount()
})

test('session start asks the daemon whether it runs this plugin’s own daemon build', async ($, on) => {
  engine(on)
  const calls = fakeDaemon(on, [])
  await start($)
  const asked = calls.find(c => c.path.startsWith('/status?script='))
  expect(decodeURIComponent(asked?.path.slice('/status?script='.length) ?? '')).toMatch(
    /\/daemon\/agentd\.mjs$/,
  )
})

test("a card's copy text holds everything the card shows, the message as its markdown source", () => {
  const liteOf = (t: TicketFixture) => lite(t as never)
  expect(cardText(liteOf(asking))).toBe(
    '#1 · acme-flutter · 修复列表滚动掉帧（提问）\n\n它在问你：\n固定行高可以吗？\n可选：可以 · 用 prototypeItem',
  )
  // A permission names no options: they are the buttons.
  expect(cardText(liteOf(permit))).toBe(
    '#4 · acme-flutter · 提交改动（提问）\n\n它要权限：\n**权限请求**\n\n```\ngit commit -m x\n```\n\n批准这一次吗？',
  )
  const report = '## 改了什么\n- 补了 `load()` 的用例'
  expect(cardText(liteOf({ ...working, lastReport: report, lastAnswer: '可以' }))).toBe(
    `#2 · acme-compute · 补 ETL 单测（在干）\n\n最近消息：\n${report}\n你答：可以`,
  )
  expect(
    cardText(
      liteOf({ ...working, state: 'ready', worktree: true, branch: 'b', lastReport: '交了' }),
    ),
  ).toBe('#2 · acme-compute · 补 ETL 单测（待审）\n\n交付说明：\n交了')
  expect(cardText(liteOf({ ...working, lastReport: null }))).toBe(
    '#2 · acme-compute · 补 ETL 单测（在干）',
  )
})

test("each live card's 复制 puts the card's text on the clipboard of the surface pressed", async ($, on) => {
  engine(on)
  const ended = { ...working, id: 9, state: 'done', needsMe: false }
  fakeDaemon(on, [asking, { ...working, lastReport: '改完一处' }, ended])
  const copies: { text: string; surface?: string }[] = []
  let isCopied = true
  on('ui.copy', (_, e) => {
    copies.push({ text: e.text, surface: e.surface })
    return { value: isCopied ? { isCopied: true } : { isCopied: false, reason: 'no-clipboard' } }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await ui.find({ key: 'copy-1' }))?.text).toBe(linked('复制', 'copy-1'))
  // An ended ticket is a line of history: nothing on it to copy.
  expect(await ui.find({ key: 'copy-9' })).toBeUndefined()
  await ui.press(link('copy-1'))
  expect(copies.at(-1)?.text).toContain('它在问你：\n固定行高可以吗？')
  expect(copies.at(-1)?.surface).toBe('vscode')
  expect(toasts.at(-1)).toBe('已复制 #1 · acme-flutter · 修复列表滚动掉帧')
  await ui.press(link('copy-2'))
  expect(copies.at(-1)?.text).toContain('最近消息：\n改完一处')
  isCopied = false
  await ui.press(link('copy-2'))
  expect(toasts.at(-1)).toContain('没能复制')
  await ui.unmount()
})

test('a message folds only where it surely takes more than four lines', () => {
  // Each block starts a line of its own, whatever the width.
  expect(isLong('一行', 60)).toBe(false)
  expect(isLong('第一段\n\n第二段\n\n第三段\n\n第四段', 60)).toBe(false)
  expect(isLong('第一段\n\n第二段\n\n第三段\n\n第四段\n\n第五段', 60)).toBe(true)
  expect(isLong('- 一\n- 二\n- 三\n- 四', 60)).toBe(false)
  expect(isLong('- 一\n- 二\n- 三\n- 四\n- 五', 60)).toBe(true)
  expect(isLong('## 标题\n正文\n- 一\n- 二', 60)).toBe(false)
  expect(isLong('## 标题\n正文\n- 一\n- 二\n- 三', 60)).toBe(true)
  // A paragraph's soft breaks join its lines; a table's rule row draws nothing.
  expect(isLong('同一段的\n第二行\n第三行\n第四行\n第五行', 60)).toBe(false)
  expect(isLong('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |', 60)).toBe(false)
  // A code block draws each of its lines; the fences draw none.
  expect(isLong('```\na\nb\nc\nd\n```', 60)).toBe(false)
  expect(isLong('```\na\nb\nc\nd\ne\n```', 60)).toBe(true)
  // Width counts at its narrowest: 1.6 cells a CJK character, 0.45 any other;
  // markup draws nothing. The card's frame and padding take 4 of the columns.
  // Four lines of 56 cells hold 224: 140 × 1.6 fits, 141 × 1.6 does not.
  expect(isLong('汉'.repeat(141), 60)).toBe(true)
  expect(isLong('汉'.repeat(140), 60)).toBe(false)
  expect(isLong('a'.repeat(498), 60)).toBe(true)
  expect(isLong('a'.repeat(497), 60)).toBe(false)
  expect(isLong(`**${'汉'.repeat(140)}**`, 60)).toBe(false)
  expect(isLong(`[${'汉'.repeat(30)}](https://example.com/${'x'.repeat(600)})`, 60)).toBe(false)
  // Unmeasured, only the block count can say.
  expect(isLong('汉'.repeat(1000), 0)).toBe(false)
  expect(isLong('a\n\nb\n\nc\n\nd\n\ne', 0)).toBe(true)
})

test('a long message folds to four lines behind one 展开全文 where it is cut, a question never does, and a new message folds again', async ($, on) => {
  const { clock } = engine(on)
  const long = ['## 改了什么', '- 一', '- 二', '- 三', '- 四'].join('\n')
  const tickets: TicketFixture[] = [
    { ...working, lastReport: long, lastAnswer: '可以' },
    { ...working, id: 3, lastReport: '一句话' },
    { ...asking, openQuestion: { id: 7, question: long, options: null } },
  ]
  fakeDaemon(on, tickets)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const folded = async () => (await ui.find({ key: 'report-2' }))?.props
  expect(await folded()).toMatchObject({ height: 4, overflow: 'hidden' })
  expect((await ui.find({ key: 'fold-2' }))?.text).toBe(linked('… 展开全文', 'fold-2'))
  // The answer stays in sight under the fold; short messages and questions show whole.
  expect(await ui.find({ type: 'Text', text: '你答：可以' })).toBeDefined()
  expect(await ui.find({ key: 'fold-3' })).toBeUndefined()
  expect(await ui.find({ key: 'fold-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Markdown', text: long })).toBeDefined()
  // One switch, a dim link where the text is cut; the caption above is no control.
  expect(await ui.find({ key: 'fold-2' })).toMatchObject({
    type: 'Markdown',
    props: { dimColor: true },
  })
  expect(await ui.findAll({ type: 'Button', text: /展开/ })).toHaveLength(0)
  expect(await ui.findAll({ type: 'Markdown', text: /展开/ })).toHaveLength(1)
  await ui.press(link('fold-2'))
  expect((await folded())?.height).toBeUndefined()
  expect((await ui.find({ key: 'fold-2' }))?.text).toBe(linked('收起', 'fold-2'))
  await ui.press(link('fold-2'))
  expect((await folded())?.height).toBe(4)
  await ui.press(link('fold-2'))
  // A new message is read from its top again.
  tickets[0] = { ...working, lastReport: `${long}\n- 五` }
  await clock.advance(12_000)
  expect((await folded())?.height).toBe(4)
  expect((await ui.find({ key: 'fold-2' }))?.text).toBe(linked('… 展开全文', 'fold-2'))
  // A reload shows every card folded again.
  await ui.press(link('fold-2'))
  expect((await folded())?.height).toBeUndefined()
  await start($)
  expect((await folded())?.height).toBe(4)
  await ui.unmount()
})

test('a card weighs its controls: the one press its state asks for, the ways in, then dim links', async ($, on) => {
  engine(on)
  fakeDaemon(on, [asking, working, review, { ...permit, id: 5 }])
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const props = async (key: string) => (await ui.find({ key }))?.props
  // A question is answered in a chat; a permission by 批准; an MR ticket by 开 MR.
  expect(await props('chat-1')).toMatchObject({ variant: 'primary' })
  expect((await props('chat-2'))?.variant).toBeUndefined()
  expect(await props('mr-4')).toMatchObject({ variant: 'primary' })
  expect(await props('approve-5')).toMatchObject({ variant: 'primary' })
  expect((await props('chat-5'))?.variant).toBeUndefined()
  // Copy, give up and stop are dim text links, never framed beside the main one.
  for (const key of ['copy-2', 'stop-2', 'discard-4']) {
    expect(await ui.find({ key })).toMatchObject({ type: 'Markdown', props: { dimColor: true } })
  }
  await ui.unmount()
})

const readTool = async (
  $: Engine,
  input: { ticket: number; what?: string; limit?: number; before?: number; row?: number },
): Promise<string> =>
  String((await $.tool.call({ tool: 'mcp__agentd-router__read', ...input })).result)

test('read summary links the ticket it carries on and the ones carrying it on, and cuts a long task', async ($, on) => {
  engine(on)
  const long = '把登录重试改成指数退避。'.repeat(150)
  fakeDaemon(
    on,
    [working, { ...working, id: 5, title: '登录重试第二轮', project: 'memos' }],
    undefined,
    {
      prompt: long,
      links: {
        5: {
          follows: { id: 2, title: '补 ETL 单测', project: 'acme-compute', state: 'done' },
          followers: [{ id: 6, title: '补测试', project: 'memos', state: 'working' }],
        },
      },
    },
  )
  await start($)
  const five = await readTool($, { ticket: 5 })
  expect(five).toContain('接续自：#2 · acme-compute · 补 ETL 单测（已结束）')
  expect(five).toContain('后续：#6 · memos · 补测试（在干）')
  expect(five).toContain(`（共 ${long.length} 字，已截断，read ticket=5 what=prompt 取全文）`)
  expect(five).not.toContain(long)
  expect(await readTool($, { ticket: 5, what: 'prompt' })).toBe(long)
  // A ticket in no chain says nothing of one.
  expect(await readTool($, { ticket: 2 })).not.toMatch(/接续自|后续/)
})

test('read events and transcript say how to go further back and how to read a cut row', async ($, on) => {
  engine(on)
  const calls = fakeDaemon(on, [working], undefined, {
    events: {
      events: [
        { id: 41, kind: 'progress', actor: 'worker', body: { text: '改完一处' } },
        { id: 42, kind: 'ready', actor: 'worker', body: { text: '好了' } },
      ],
      more: true,
    },
    transcript: {
      rows: [
        { role: 'user', text: '开始', tools: [], at: 100, isCut: false },
        { role: 'assistant', text: '长长的', tools: ['Edit'], at: 900, isCut: true },
      ],
      more: true,
    },
    row: { role: 'assistant', text: '长长的全文', tools: ['Edit'], at: 900, isCut: false },
  })
  await start($)
  const events = await readTool($, { ticket: 2, what: 'events', limit: 2 })
  expect(events.split('\n')[0]).toBe('（更早还有：read ticket=2 what=events before=41）')
  expect(events).toContain('ready（worker）：好了')
  await readTool($, { ticket: 2, what: 'events', before: 41 })
  expect(calls.at(-1)?.path).toBe('/tickets/2/events?limit=20&before=41')

  const tail = await readTool($, { ticket: 2, what: 'transcript' })
  expect(tail.split('\n')[0]).toBe('（更早还有：read ticket=2 what=transcript before=100）')
  expect(tail).toContain(
    'assistant [Edit]：长长的…（已截断，read ticket=2 what=transcript row=900 取全文）',
  )
  const whole = await readTool($, { ticket: 2, what: 'transcript', row: 900 })
  expect(calls.at(-1)?.path).toBe('/tickets/2/transcript/900')
  expect(whole).toBe('assistant [Edit]：长长的全文')
})

test('read events and transcript from a daemon older than paging still read', async ($, on) => {
  engine(on)
  fakeDaemon(on, [working], undefined, {
    events: [{ id: 1, kind: 'dispatched', actor: 'router', body: { text: 'p' } }],
    transcript: [{ role: 'user', text: '开始', tools: [] }],
  })
  await start($)
  expect(await readTool($, { ticket: 2, what: 'events' })).toBe('dispatched（router）：p')
  expect(await readTool($, { ticket: 2, what: 'transcript' })).toBe('user：开始')
})

test('find asks the daemon by word and project, and lists ended tickets with their day', async ($, on) => {
  engine(on)
  const ended = new Date(2026, 10, 3, 15).getTime()
  const calls = fakeDaemon(on, [], undefined, {
    found: [
      { ...working, id: 9, title: '登录第二轮', project: 'memos', followsId: 4 },
      {
        ...working,
        id: 4,
        title: '修登录',
        project: 'memos',
        state: 'done',
        endedAt: ended,
        lastReport: '已合入',
      },
    ],
  })
  await start($)
  const text = String(
    (await $.tool.call({ tool: 'mcp__agentd-router__find', query: ' 登录 ', project: 'memos' }))
      .result,
  )
  expect(calls.at(-1)?.path).toBe(`/tickets/search?q=${encodeURIComponent('登录')}&project=memos`)
  expect(text.split('\n')).toEqual([
    '#9 · memos · 登录第二轮（在干） · 接续 #4 · 定位到 itemExtent',
    '#4 · memos · 修登录（已结束 · 11月3日结束） · 已合入',
  ])
})

test('dispatch carries follows to the daemon only when it is a ticket number', async ($, on) => {
  engine(on)
  const calls = fakeDaemon(on, [])
  await start($)
  const send = (extra: Record<string, unknown>) =>
    $.tool.call({
      tool: 'mcp__agentd-router__dispatch',
      project: 'memos',
      title: 't',
      prompt: 'p',
      ...extra,
    })
  await send({ follows: 4 })
  await send({ follows: '四' })
  const posts = calls.filter(c => c.method === 'POST' && c.path === '/tickets')
  expect(posts[0]?.body).toMatchObject({ follows: 4 })
  expect(posts[1]?.body).not.toHaveProperty('follows')
})
