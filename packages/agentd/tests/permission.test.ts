import { describe, expect, test } from 'vitest'

import type { AgentdClient } from '../src/client.js'
import {
  grantKey,
  isApproval,
  permissionQuestion,
  runHook,
  shellQuote,
  workerSettings,
} from '../src/permission.js'

describe('isApproval', () => {
  test('a plain yes approves', () => {
    for (const a of ['批准', '准奏', ' 同意。', 'OK', 'yes!', '可以', '批准，下次别这样'])
      expect(isApproval(a), a).toBe(true)
  })

  test('anything else is a no', () => {
    for (const a of ['拒绝', '不批准', '批准不了', '先别', '', '1', '好像不行', 'no'])
      expect(isApproval(a), a).toBe(false)
  })
})

describe('grantKey', () => {
  test('ignores key order and the description, nothing else', () => {
    const a = grantKey('Bash', { command: 'git commit -m x', description: '提交', timeout: 5 })
    const b = grantKey('Bash', {
      timeout: 5,
      command: 'git commit -m x',
      description: '另一个说法',
    })
    expect(a).toBe(b)
    expect(grantKey('Bash', { command: 'git commit -m y' })).not.toBe(
      grantKey('Bash', { command: 'git commit -m x' }),
    )
    expect(grantKey('Write', { command: 'x' })).not.toBe(grantKey('Bash', { command: 'x' }))
  })
})

test('the question shows the command, the refusal and asks for one approval', () => {
  const q = permissionQuestion('denied', {
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m "x"', description: '提交改动' },
    reason: 'Committing is outside the task',
  })
  expect(q).toContain('`Bash`')
  expect(q).toContain('```\ngit commit -m "x"\n```')
  expect(q).toContain('Committing is outside the task')
  expect(q).toContain('提交改动')
  expect(q.endsWith('批准这一次吗？')).toBe(true)
})

describe('workerSettings', () => {
  const settings = JSON.parse(
    workerSettings({
      node: '/opt/node bin/node',
      script: "/x/it's/agentd-hook.mjs",
      url: 'http://127.0.0.1:7707',
      ticket: 6,
      flag: '/h/mcp/6.grant',
    }),
  )

  test('quotes paths for the shell and waits a day for a person', () => {
    const denied = settings.hooks.PermissionDenied[0].hooks[0]
    expect(denied.timeout).toBe(86_400)
    expect(denied.command).toBe(
      `AGENTD_URL='http://127.0.0.1:7707' AGENTD_TICKET=6 exec '/opt/node bin/node' ${shellQuote("/x/it's/agentd-hook.mjs")} denied`,
    )
  })

  test('PreToolUse starts node only while a grant flag exists', () => {
    const pre = settings.hooks.PreToolUse[0].hooks[0]
    expect(pre.command).toMatch(/^if \[ -e '\/h\/mcp\/6\.grant' \]; then .* pre; fi$/)
    expect(pre.timeout).toBe(30)
  })
})

/** A daemon stand-in: answers ask/poll/take from a script and records the calls. */
function fakeClient(script: {
  ask?: { ok: boolean; questionId?: number } | 'down'
  polls?: ({ answered: boolean; answer: string | null; withdrawn: boolean } | 'down')[]
  granted?: boolean | 'down'
}) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const polls = [...(script.polls ?? [])]
  const reply = <T>(value: unknown): Promise<{ status: number; data: T }> => {
    if (value === 'down') return Promise.reject(new Error('ECONNREFUSED'))
    return Promise.resolve({ status: 200, data: value as T })
  }
  const client = {
    post: <T>(path: string, body?: unknown) => {
      calls.push({ method: 'POST', path, body })
      if (path.endsWith('/ask')) return reply<T>(script.ask ?? { ok: true, questionId: 9 })
      return reply<T>(script.granted === 'down' ? 'down' : { granted: script.granted ?? false })
    },
    get: <T>(path: string) => {
      calls.push({ method: 'GET', path })
      return reply<T>(polls.shift() ?? { answered: false, answer: null, withdrawn: true })
    },
  } as unknown as AgentdClient
  return { client, calls }
}

const call = { tool_name: 'Bash', tool_input: { command: 'git commit' }, reason: 'no' }
const deps = (client: AgentdClient) => ({ client, ticket: 6, waitSeconds: 1, retryMs: 1 })

describe('runHook', () => {
  test('denied + approved: asks once with the grant key, then says retry', async () => {
    const { client, calls } = fakeClient({
      polls: [
        { answered: false, answer: null, withdrawn: false },
        'down',
        { answered: true, answer: '批准', withdrawn: false },
      ],
    })
    const out = await runHook('denied', call, deps(client))
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true } })
    expect(calls[0]).toMatchObject({
      path: '/tickets/6/ask',
      body: {
        kind: 'permission',
        options: ['批准', '拒绝'],
        grantKey: grantKey('Bash', call.tool_input),
      },
    })
    expect(calls.filter(c => c.method === 'GET')).toHaveLength(3)
  })

  test('denied + rejected, withdrawn or daemon down: prints nothing, the refusal stands', async () => {
    const rejected = fakeClient({ polls: [{ answered: true, answer: '拒绝', withdrawn: false }] })
    expect(await runHook('denied', call, deps(rejected.client))).toBeNull()
    const withdrawn = fakeClient({ polls: [{ answered: false, answer: null, withdrawn: true }] })
    expect(await runHook('denied', call, deps(withdrawn.client))).toBeNull()
    const down = fakeClient({ ask: 'down' })
    expect(await runHook('denied', call, deps(down.client))).toBeNull()
  })

  test('request: approval allows in place, no grant asked for; anything else denies with why', async () => {
    const yes = fakeClient({ polls: [{ answered: true, answer: '同意', withdrawn: false }] })
    expect(await runHook('request', call, deps(yes.client))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    })
    expect((yes.calls[0]?.body as Record<string, unknown>).grantKey).toBeUndefined()
    const no = fakeClient({ polls: [{ answered: true, answer: '不要提交', withdrawn: false }] })
    expect(await runHook('request', call, deps(no.client))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: '用户没有批准：不要提交' },
      },
    })
  })

  test('pre: allows only what the daemon says is granted', async () => {
    const granted = fakeClient({ granted: true })
    expect(await runHook('pre', call, deps(granted.client))).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    })
    expect(granted.calls[0]).toMatchObject({
      path: '/tickets/6/grants/take',
      body: { key: grantKey('Bash', call.tool_input) },
    })
    expect(await runHook('pre', call, deps(fakeClient({ granted: false }).client))).toBeNull()
    expect(await runHook('pre', call, deps(fakeClient({ granted: 'down' }).client))).toBeNull()
  })
})
