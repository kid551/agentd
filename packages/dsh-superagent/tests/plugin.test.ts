import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { apply, inject, name } from '../src/host/index.js'

const SERVICES = [
  'agents',
  'sessionController',
  'storageDomain',
  'webServer',
  'connection',
  'workspaceRegistry',
]
import { memoryTables, type Table } from '../src/host/tables.js'

// The host plugin's wiring against a fake dsh context: the shapes are the ones
// read from the installed 0.2.1-rc.5 packages (see implementation-notes.md).

type Listener = (...args: unknown[]) => unknown

/** Set while a `session/event` is being published; dsh refuses appends then. */
let publishing = false
const append = (): void => {
  if (publishing)
    throw new Error('session append cannot reenter while another append is being published')
}

class FakeAgent {
  status: 'idle' | 'running' = 'idle'
  inbox: { mode: string; message: { content: { text: string }[]; source: { kind: string } } }[] = []
  tools: { name: string }[] = []
  sections: { name: string; text: string }[] = []
  listeners = new Map<string, Listener>()
  ctx = {
    tools: {
      register: (tool: { name: string }) => {
        this.tools.push(tool)
        return () => {
          this.tools = this.tools.filter(t => t !== tool)
        }
      },
    },
    systemPrompt: {
      section: (s: { name: string; text: string }) => {
        this.sections.push(s)
        return () => undefined
      },
    },
    on: (event: string, listener: Listener) => {
      this.listeners.set(event, listener)
      return () => this.listeners.delete(event)
    },
  }
  session = {
    deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: '好了' }] }],
  }
  constructor(readonly id: string) {}
  cancel(): void {
    this.status = 'idle'
  }
  followup(message: never): void {
    append()
    this.inbox.push({ mode: 'followup', message })
    this.status = 'running'
  }
  steer(message: never): void {
    append()
    this.inbox.push({ mode: 'steer', message })
  }
  inject(message: never): void {
    append()
    this.inbox.push({ mode: 'inject', message })
  }
}

function fakeContext(project: string) {
  const listeners = new Map<string, Listener[]>()
  const effects: (() => unknown)[] = []
  const agents = new Map<string, FakeAgent>()
  const routes = new Map<string, { handler: Listener }>()
  const tables = memoryTables()
  const emit = async (event: string, ...args: unknown[]) => {
    // dsh calls session/event observers synchronously inside the append.
    publishing = event === 'session/event'
    try {
      for (const l of listeners.get(event) ?? []) l(...args)
    } finally {
      publishing = false
    }
    await new Promise(r => setImmediate(r))
  }
  const ctx = {
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () =>
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter(l => l !== listener),
        )
    },
    effect(run: () => (() => unknown) | void) {
      const dispose = run()
      if (dispose) effects.push(dispose)
    },
    get: () => undefined,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    agents: { get: (id: string) => agents.get(id), list: () => [...agents.values()] },
    sessionController: {
      async create(req: { sessionId: string }) {
        const agent = new FakeAgent(req.sessionId)
        agents.set(req.sessionId, agent)
        await emit('agent/created', { agent })
        return { sessionId: req.sessionId }
      },
      async resolveAgent(id: string) {
        const agent = agents.get(id)
        return agent ? { agent } : { error: 'gone' }
      },
    },
    workspaceRegistry: {
      async create() {
        return { id: 'ws', attachSession: async () => undefined }
      },
      list: () => [
        { id: 'ws', path: project, title: 'demo' },
        { id: 'gone', path: join(project, 'deleted-folder'), title: 'gone' },
      ],
    },
    connection: {
      admit: (req: { headers: Record<string, string> }) =>
        req.headers.cookie === 'dsh=ok' ? { peer: {} } : { rejection: 401 },
    },
    webServer: {
      register(route: { path: string; handler: Listener }) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    storageDomain: {
      async open() {
        return {
          table: (n: 'tickets' | 'events' | 'meta') => tables[n] as Table<unknown>,
          close: async () => undefined,
        }
      },
    },
  }
  // Like cordis: reading a service the plugin did not list in `inject` throws.
  const strict = new Proxy(ctx, {
    get(target, prop: string) {
      if (SERVICES.includes(prop) && !inject.includes(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return target[prop as keyof typeof target]
    },
  })
  return { ctx: strict, agents, routes, emit, dispose: () => effects.reverse().forEach(d => d()) }
}

let cleanup: (() => void) | undefined
afterEach(() => cleanup?.())

const waitFor = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 50 && !check(); i++) await new Promise(r => setTimeout(r, 5))
}

describe('host plugin', () => {
  it('declares itself to the Loader', () => {
    expect(name).toBe('superagent')
    expect(inject).toContain('sessionController')
  })

  it('serves the board only to requests the Host admits', async () => {
    const f = fakeContext(mkdtempSync(join(tmpdir(), 'sa-plugin-')))
    cleanup = f.dispose
    await apply(f.ctx as never, {
      roots: [],
      routerCwd: mkdtempSync(join(tmpdir(), 'sa-router-')),
      logFile: join(tmpdir(), `sa-${Date.now()}.log`),
    })
    expect(request(f, '/superagent/api/state', {}).status).toBe(401)
    expect(request(f, '/superagent/api/action', {}).status).toBe(401)
    expect(request(f, '/superagent/api/state', { cookie: 'dsh=ok' }).status).toBe(200)
  })

  it('never writes to a Session from inside its own event, and never rejects unhandled', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const f = fakeContext(mkdtempSync(join(tmpdir(), 'sa-plugin-')))
      cleanup = f.dispose
      await apply(f.ctx as never, {
        roots: [],
        routerCwd: mkdtempSync(join(tmpdir(), 'sa-router-')),
        logFile: join(tmpdir(), `sa-${Date.now()}.log`),
      })
      await waitFor(() => f.agents.size === 1)
      const router = [...f.agents.values()][0] as FakeAgent
      // The person types in the Router: the overview is due, so the plugin injects it.
      await f.emit(
        'session/event',
        { id: router.id },
        {
          type: 'user/message',
          data: { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } },
        },
      )
      await waitFor(() => router.inbox.some(m => m.mode === 'inject'))
      expect(router.inbox.find(m => m.mode === 'inject')?.message.content[0]?.text).toContain(
        '奏折',
      )
      await new Promise(r => setTimeout(r, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('creates the Router with routing tools and gives Workers their own tools and prompt', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sa-plugin-'))
    const f = fakeContext(project)
    cleanup = f.dispose
    await apply(f.ctx as never, {
      roots: [],
      routerCwd: mkdtempSync(join(tmpdir(), 'sa-router-')),
      logFile: join(tmpdir(), `sa-${Date.now()}.log`),
    })
    await waitFor(() => f.agents.size === 1)
    const router = [...f.agents.values()][0] as FakeAgent
    expect(router.tools.map(t => t.name)).toContain('superagent_dispatch')
    expect(router.sections[0]?.text).toContain('你是 Super-agent 的 Router')

    const dispatch = router.tools.find(t => t.name === 'superagent_dispatch') as unknown as {
      execute(args: unknown, exec: unknown): Promise<{ text: string }>
    }
    const out = await dispatch.execute(
      { title: '修 bug', task: '修掉崩溃', project: 'demo' },
      { agent: router },
    )
    expect(out.text).toContain('已派 #1')
    const projects = router.tools.find(t => t.name === 'superagent_projects') as unknown as {
      execute(args: unknown, exec: unknown): Promise<{ text: string }>
    }
    const listed = (await projects.execute({}, { agent: router })).text
    expect(listed).toContain('demo')
    expect(listed).not.toContain('gone') // its folder no longer exists

    const worker = [...f.agents.values()].find(a => a !== router) as FakeAgent
    expect(worker.tools.map(t => t.name)).toEqual([
      'superagent_report',
      'superagent_mr_consent',
      'superagent_done',
    ])
    expect(worker.sections[0]?.text).toContain('负责奏折 #1「修 bug」')
    expect(worker.inbox[0]?.message.source).toMatchObject({
      kind: 'agent-message',
      senderSessionId: router.id,
    })
    expect([...worker.listeners.keys()].sort()).toEqual([
      'approval/request',
      'user-questions/request',
    ])

    // A question shown in the Worker's Session is mirrored, then settled.
    let answer!: (v: unknown) => void
    const asking = worker.listeners.get('user-questions/request')?.(
      { questions: [{ id: 'q', question: 'A 还是 B？' }] },
      () => new Promise(r => (answer = r)),
    )
    await waitFor(() => readState(f).tickets[0]?.state === 'asking')
    expect(readState(f).tickets[0]?.pending?.summary).toBe('A 还是 B？')
    answer({ answers: [] })
    await asking
    await waitFor(() => readState(f).tickets[0]?.state === 'working')

    // Activity from the Worker's Session reaches the board.
    await f.emit(
      'session/event',
      { id: worker.id },
      { type: 'tool/call', data: { name: 'bash', args: { command: 'pnpm test' } } },
    )
    expect(readState(f).tickets[0]?.activity?.lines).toEqual(['▸ bash pnpm test'])

    // The person typing in the Worker's Session is told to the Router quietly.
    await f.emit(
      'session/event',
      { id: worker.id },
      {
        type: 'user/message',
        data: { content: [{ type: 'text', text: '用 B' }], source: { kind: 'user' } },
      },
    )
    await waitFor(() => router.inbox.some(m => m.mode === 'inject'))
    expect(router.inbox.find(m => m.mode === 'inject')?.message.content[0]?.text).toContain(
      '用户在 #1',
    )

    // Dispose takes the scoped tools back.
    f.dispose()
    cleanup = undefined
    expect(worker.tools).toHaveLength(0)
    expect(router.tools).toHaveLength(0)
  })
})

function readState(f: ReturnType<typeof fakeContext>): {
  tickets: { state: string; pending?: { summary: string }; activity?: { lines: string[] } }[]
} {
  const out = request(f, '/superagent/api/state', { cookie: 'dsh=ok' })
  expect(out.status).toBe(200)
  return JSON.parse(out.body)
}

function request(
  f: ReturnType<typeof fakeContext>,
  path: string,
  headers: Record<string, string>,
): { status: number; body: string } {
  const out = { status: 0, body: '' }
  const res = {
    writeHead: (status: number) => (out.status = status),
    end: (b: string) => (out.body = b),
  }
  f.routes.get(path)?.handler({ headers, method: 'GET' }, res)
  return out
}
