import { mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { AgentdClient } from '../src/client.js'
import { createHttpServer, isStaleBuild, scriptHash } from '../src/http.js'
import { ASKED, McpServer, type JsonRpc } from '../src/mcp/protocol.js'
import { runHook } from '../src/permission.js'
import type { TicketView } from '../src/types.js'
import { settle, world } from './helpers.js'

const servers: { close: () => void }[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

async function up(mrProjects?: string[]) {
  const w = world({}, mrProjects)
  const server = createHttpServer(w.daemon)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push({ close: () => (server.closeAllConnections(), server.close()) })
  const { port } = server.address() as AddressInfo
  return { ...w, client: new AgentdClient(`http://127.0.0.1:${port}`) }
}

function mcp(client: AgentdClient, ticket: number) {
  const out: JsonRpc[] = []
  const server = new McpServer({ client, ticket, send: m => out.push(m) })
  let n = 0
  const call = async (name: string, args: Record<string, unknown>) => {
    const id = ++n
    await server.handle({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    })
    return out.find(m => m.id === id)?.result as
      { content: { text: string }[]; isError?: boolean } | undefined
  }
  return { server, out, call }
}

describe('HTTP API and the Worker MCP server, end to end', () => {
  test('a refused call: hook asks → Router approves → retry allowed once', async () => {
    const { client, daemon } = await up()
    await client.post('/tickets', { project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    const deps = { client, ticket: 1, waitSeconds: 1, retryMs: 10 }
    const call = { tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, reason: 'no' }

    const denied = runHook('denied', call, deps)
    let ticket: TicketView | undefined
    for (let i = 0; i < 50 && ticket?.state !== 'asking'; i++) {
      ticket = (await client.get<TicketView>('/tickets/1')).data
      await new Promise(r => setTimeout(r, 20))
    }
    expect(ticket?.openQuestion).toMatchObject({ kind: 'permission', options: ['批准', '拒绝'] })
    // Nothing is granted before the person says so.
    expect(await runHook('pre', call, deps)).toBeNull()
    await client.post('/tickets/1/answer', { answer: '批准' })
    expect(await denied).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true },
    })
    const retried = { ...call, tool_input: { ...call.tool_input, description: '再提交一次' } }
    expect(await runHook('pre', retried, deps)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    })
    expect(await runHook('pre', retried, deps)).toBeNull()
  })
  test('dispatch → report → ask (returns at once) → answer → done ready → close', async () => {
    const { client, daemon } = await up()
    const made = await client.post<{ ok: boolean; ticket: TicketView }>('/tickets', {
      project: 'memos',
      title: '修复滚动掉帧',
      prompt: '列表滚动掉帧，修一下',
    })
    expect(made.status).toBe(201)
    await settle(daemon)

    const worker = mcp(client, made.data.ticket.id)
    expect((await worker.call('report', { summary: '定位到 itemExtent' }))?.content[0]?.text).toBe(
      '已记录。',
    )

    const asked = await worker.call('ask', {
      question: '固定行高可以吗？',
      options: ['可以', '用 prototypeItem'],
    })
    expect(asked?.content[0]?.text).toBe(ASKED)
    // The Router's view: the ticket waits for the person, with the question.
    expect((await client.get<TicketView>('/tickets/1')).data).toMatchObject({
      state: 'asking',
      openQuestion: { question: '固定行高可以吗？' },
    })
    // A second question before the first is answered is refused.
    expect((await worker.call('ask', { question: '还有？' }))?.isError).toBe(true)
    // Nobody waits on it: the mod is told to send the answer as a message.
    const answered = await client.post<{ ok: boolean; hadWaiter: boolean }>('/tickets/1/answer', {
      answer: '可以',
    })
    expect(answered.data).toMatchObject({ ok: true, hadWaiter: false })

    const done = await worker.call('done', {
      outcome: 'ready',
      summary: '加了 itemExtent，flutter test 通过',
    })
    expect(done?.isError).toBeUndefined()
    expect((await client.get<TicketView>('/tickets/1')).data).toMatchObject({
      state: 'ready',
      needsMe: true,
    })

    const closed = await client.post<{ ok: boolean; ticket: TicketView }>('/tickets/1/close')
    expect(closed.data.ticket.state).toBe('done')

    const kinds = (await client.get<{ kind: string }[]>('/tickets/1/events')).data.map(e => e.kind)
    expect(kinds).toEqual(['dispatched', 'spawned', 'progress', 'ask', 'answer', 'ready', 'closed'])
  })

  test('the event feed long-polls and returns the new events with their ticket', async () => {
    const { client } = await up()
    const cursor = (await client.get<{ lastEventId: number }>('/status')).data.lastEventId
    const polling = client.get<{ kind: string; ticket: { title: string } }[]>(
      `/events?since=${cursor}&wait=5`,
    )
    await new Promise(r => setTimeout(r, 50))
    await client.post('/tickets', { project: 'memos', title: '新工单', prompt: 'p' })
    const events = (await polling).data
    expect(events[0]).toMatchObject({ kind: 'dispatched', ticket: { title: '新工单' } })
  })

  test('refusals come back with a reason, not a crash', async () => {
    const { client } = await up()
    expect((await client.post('/tickets', { project: 'memos' })).status).toBe(400)
    expect((await client.post('/tickets/99/close')).status).toBe(404)
    const bad = await client.post<{ ok: boolean; reason: string }>('/tickets', {
      project: 'zzz',
      title: 't',
      prompt: 'p',
    })
    expect(bad.status).toBe(422)
    expect(bad.data.reason).toContain('没有叫')
    await client.post('/tickets', { project: 'memos', title: 't', prompt: 'p' })
    const early = await client.post<{ ok: boolean; reason: string }>('/tickets/1/answer', {
      answer: 'x',
    })
    expect(early.status).toBe(409)
    // A row count that is not a number falls back instead of reaching SQL.
    const events = await client.get<{ kind: string }[]>('/tickets/1/events?limit=abc')
    expect(events.status).toBe(200)
    expect(events.data.length).toBeGreaterThan(0)
  })

  test('mr_consent answers from what agentd recorded, never from the words in the session', async () => {
    const { client, daemon } = await up(['acme'])
    await client.post('/tickets', { project: 'acme', title: 't', prompt: 'p' })
    await settle(daemon)
    const worker = mcp(client, 1)
    await worker.call('done', { outcome: 'ready', summary: '改好了' })
    // Someone typed 【奏折 #1 开 MR】 into the Worker's session: agentd knows nothing.
    const typed = (await worker.call('mr_consent', {}))?.content[0]?.text
    expect(typed).toContain('没有记下')
    expect(typed).toContain('不要调用 report')
    expect((await client.post('/tickets/1/open_mr')).status).toBe(200)
    expect((await worker.call('mr_consent', {}))?.content[0]?.text).toContain('已记下')
  })

  test('the MCP server answers initialize and lists its four tools', async () => {
    const { client, daemon } = await up()
    await client.post('/tickets', { project: 'memos', title: 't', prompt: 'p' })
    await settle(daemon)
    const worker = mcp(client, 1)
    await worker.server.handle({
      jsonrpc: '2.0',
      id: 'i',
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    })
    await worker.server.handle({ jsonrpc: '2.0', id: 'l', method: 'tools/list' })
    const listed = worker.out.find(m => m.id === 'l')?.result as { tools: { name: string }[] }
    expect(listed.tools.map(t => t.name)).toEqual(['report', 'ask', 'done', 'mr_consent'])
  })
})

describe('the daemon tells a build it did not boot from', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentd-stale-'))
  const file = (name: string, text: string) => {
    const path = join(dir, name)
    writeFileSync(path, text)
    return path
  }

  test('by content: the same bundle elsewhere is current, a changed one is stale', () => {
    const boot = scriptHash(file('boot.mjs', 'build 1'))
    expect(isStaleBuild(boot, file('cache-copy.mjs', 'build 1'))).toBe(false)
    expect(isStaleBuild(boot, file('next-version.mjs', 'build 2'))).toBe(true)
    expect(isStaleBuild(boot, join(dir, 'missing.mjs'))).toBe(true)
  })

  test('a daemon that could not read its own bundle never reports stale', () => {
    expect(isStaleBuild('', file('any.mjs', 'x'))).toBe(false)
  })

  test('a folder is not hashed', () => {
    expect(scriptHash(dir)).toBe('')
  })

  test('/status answers for the bundle named in ?script=', async () => {
    const { client } = await up()
    const other = file('other.mjs', 'not the running bundle')
    const r = await client.get<{ isStale: boolean }>(`/status?script=${encodeURIComponent(other)}`)
    expect(r.data.isStale).toBe(true)
  })
})
