import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { isWorkerGone, parseAgents, parseBgId, spawnArgv, type WorkerInfo } from '../src/claude.js'
import { findTranscript, readActivity, readTail } from '../src/transcript.js'

describe('spawnArgv', () => {
  const spec = {
    name: 'agentd-w-3',
    cwd: '/r/memos',
    model: 'opus',
    permissionMode: 'auto',
    mcpConfigPath: '/h/mcp/3.json',
    systemPrompt: 'SYS',
    taskPrompt: '【agentd 工单 #3】t',
  }

  test('ends with -n name then the prompt, so no list flag swallows the prompt', () => {
    const argv = spawnArgv(spec)
    expect(argv[0]).toBe('--bg')
    expect(argv.slice(-3)).toEqual(['-n', 'agentd-w-3', '【agentd 工单 #3】t'])
    const listFlags = ['--mcp-config', '--allowedTools', '--disallowedTools']
    for (const flag of listFlags) {
      const at = argv.indexOf(flag)
      expect(argv[at + 2]?.startsWith('-')).toBe(true)
    }
    expect(argv).toContain(
      'mcp__agentd__report,mcp__agentd__ask,mcp__agentd__done,mcp__agentd__mr_consent',
    )
    expect(argv).not.toContain('--worktree')
  })

  test('refuses extra tools in the one --disallowedTools value', () => {
    const argv = spawnArgv({ ...spec, disallowedTools: ['ExitPlanMode'] })
    expect(argv[argv.indexOf('--disallowedTools') + 1]).toBe('AskUserQuestion,ExitPlanMode')
  })

  test('passes the hook settings and a session to resume, each with its value', () => {
    const argv = spawnArgv({ ...spec, settings: '{"hooks":{}}', resume: 'sess-1' })
    expect(argv[argv.indexOf('--settings') + 1]).toBe('{"hooks":{}}')
    expect(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 3)).toEqual([
      '--resume',
      'sess-1',
      '-n',
    ])
    expect(spawnArgv(spec)).not.toContain('--settings')
    expect(spawnArgv(spec)).not.toContain('--resume')
  })
})

test('parseBgId reads the short id claude --bg prints', () => {
  const out =
    'Starting background service…\nbackgrounded · 2bb79421 · agentd-w-0\n  claude agents  list sessions'
  expect(parseBgId(out)).toBe('2bb79421')
  expect(parseBgId('Workspace not trusted.')).toBeNull()
})

test('parseAgents keeps background sessions only', () => {
  const json = JSON.stringify([
    { pid: 1, cwd: '/a', kind: 'interactive', sessionId: 's1', name: 'x', status: 'idle' },
    {
      pid: 2,
      id: '2bb79421',
      cwd: '/p',
      kind: 'background',
      startedAt: 5,
      sessionId: 's2',
      name: 'agentd-w-0',
      status: 'idle',
      state: 'done',
    },
  ])
  expect(parseAgents(json)).toEqual([
    {
      name: 'agentd-w-0',
      id: '2bb79421',
      sessionId: 's2',
      cwd: '/p',
      status: 'idle',
      state: 'done',
      pid: 2,
      startedAt: 5,
    },
  ])
})

test('a Worker is gone when the list has no pid for it, whatever its state says', () => {
  // As `claude agents --json --all` lists them: a live idle session carries
  // state "done" too, so only the pid tells.
  const [live, ended] = parseAgents(
    JSON.stringify([
      { pid: 7, id: 'a', kind: 'background', name: 'agentd-w-1', status: 'idle', state: 'done' },
      { id: 'b', kind: 'background', name: 'agentd-w-2', state: 'done' },
    ]),
  ) as [WorkerInfo, WorkerInfo]
  expect(isWorkerGone(live)).toBe(false)
  expect(isWorkerGone(ended)).toBe(true)
})

describe('transcripts', () => {
  test('are found by session id in whichever project folder holds them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentd-proj-'))
    mkdirSync(join(dir, '-Users-x-project2'))
    writeFileSync(join(dir, '-Users-x-project2', 'abc.jsonl'), '')
    expect(findTranscript('abc', dir)).toBe(join(dir, '-Users-x-project2', 'abc.jsonl'))
    expect(findTranscript('missing', dir)).toBeNull()
  })

  test('readTail keeps prompts, answers and tool names, and skips meta rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentd-tail-'))
    const file = join(dir, 's.jsonl')
    const rows = [
      { type: 'queue-operation', operation: 'enqueue' },
      { type: 'user', message: { content: '列出文件' } },
      { type: 'user', isMeta: true, message: { content: 'hidden' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'a.txt' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'a.txt b.txt' }] } },
    ]
    writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\nnot json\n')
    expect(readTail(file)).toEqual([
      { role: 'user', text: '列出文件', tools: [] },
      { role: 'assistant', text: '', tools: ['Bash'] },
      { role: 'assistant', text: 'a.txt b.txt', tools: [] },
    ])
    expect(readTail(file, 1)).toHaveLength(1)
  })

  test('readActivity gives the last lines a Worker wrote, tool calls by what they do, and when', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentd-act-'))
    const file = join(dir, 's.jsonl')
    const tool = (name: string, input: Record<string, unknown>, second: string) => ({
      type: 'assistant',
      timestamp: `2026-11-04T01:00:${second}.000Z`,
      message: { content: [{ type: 'tool_use', name, input }] },
    })
    const rows = [
      { type: 'user', message: { content: '跑测试' } },
      tool('Bash', { command: 'pnpm test', description: 'Run the tests' }, '00'),
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      {
        type: 'assistant',
        timestamp: '2026-11-04T01:00:05.000Z',
        message: { content: [{ type: 'text', text: '测试\n全部通过' }] },
      },
      tool('mcp__agentd__report', { summary: '测完了' }, '09'),
    ]
    writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    expect(readActivity(file)).toEqual({
      lines: ['测试 全部通过', '▸ report 测完了'],
      at: Date.parse('2026-11-04T01:00:09.000Z'),
    })
    expect(readActivity(file, 3).lines[0]).toBe('▸ Bash Run the tests')

    // A grown file is read again; a long line is cut to one.
    writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-04T01:01:00.000Z',
        message: { content: [{ type: 'text', text: 'x'.repeat(300) }] },
      }) + '\n',
      { flag: 'a' },
    )
    const grown = readActivity(file, 2, 20)
    expect(grown.lines[1]).toBe(`${'x'.repeat(19)}…`)
    expect(grown.at).toBe(Date.parse('2026-11-04T01:01:00.000Z'))
  })
})
