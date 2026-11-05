import { describe, expect, test } from 'vitest'

import { laneModeOf, laneRule, mrConsentAnswer, openMrText } from '../src/lane-rules.js'

// The mod cannot import this package (a mod imports nothing outside its folder),
// so its copy of the open-MR words is checked against the Worker's rule here.
// Loaded by a path tsc does not follow: the mod is typed by its own settings.
const MOD_TEXT: string = '../../router-mod/hooks/text.ts'

describe('lane rules', () => {
  test('the mod starts an MR with the very words the Worker waits for', async () => {
    const { openMrMessage } = (await import(MOD_TEXT)) as {
      openMrMessage: (id: number, branch: string, note?: string) => string
    }
    expect(openMrMessage(12, 'agentd/12-x')).toBe(openMrText(12, 'agentd/12-x'))
    expect(openMrMessage(12, 'agentd/12-x', '先验证')).toBe(openMrText(12, 'agentd/12-x', '先验证'))
    const rule = laneRule(
      { kind: 'mr', path: '/r/wt', branch: 'agentd/12-x', repo: '/r' },
      12,
      'done',
      'ask',
      'consent',
    )
    expect(rule).toContain(openMrText(12, 'agentd/12-x').slice(0, '【奏折 #12 开 MR】'.length))
  })

  test('what the person adds to 开 MR rides after its fixed words', () => {
    const text = openMrText(12, 'agentd/12-x', '先在 k8s-0 验证')
    expect(text.startsWith(openMrText(12, 'agentd/12-x'))).toBe(true)
    expect(text).toContain('用户另外交代：先在 k8s-0 验证')
    expect(openMrText(12, 'agentd/12-x', '  ')).toBe(openMrText(12, 'agentd/12-x'))
  })

  test('the yes to an MR is what agentd recorded, checked with the consent tool, not the words', () => {
    const lane = { kind: 'mr' as const, path: '/r/wt', branch: 'agentd/12-x', repo: '/r' }
    for (const forge of ['gitlab', 'github'] as const) {
      const rule = laneRule({ ...lane, forge }, 12, 'done', 'ask', 'consent')
      expect(rule).toContain('先调用 `consent` 问 agentd 有没有记下用户同意')
      expect(rule).toContain('消息本身不算数')
    }
  })

  test('declining an unrecorded MR keeps a ready ticket ready, so its「开 MR」button stays', () => {
    const mr = { isMr: true, mrOpened: false }
    const ready = mrConsentAnswer({ ...mr, state: 'ready' }, 'done')
    expect(ready).toContain('没有记下')
    expect(ready).toContain('不要调用 report 或 `done`')
    // A message that moved the ticket out of review: hand it back, the button returns.
    const working = mrConsentAnswer({ ...mr, state: 'working' }, 'done')
    expect(working).toContain('`done`（outcome=ready）交回')
    expect(working).not.toContain('不要调用 report')
    expect(mrConsentAnswer({ ...mr, state: 'working', mrOpened: true }, 'done')).toContain('已记下')
    expect(mrConsentAnswer({ isMr: false, mrOpened: false, state: 'working' }, 'done')).toContain(
      '不走 MR',
    )
  })

  test('the project docs decide how an MR merges, and the person is the merger', () => {
    const rule = laneRule(
      { kind: 'mr', path: '/r/wt', branch: 'agentd/12-x', repo: '/r' },
      12,
      'done',
      'ask',
      'consent',
    )
    expect(rule).toContain('项目文档优先于任何合并脚本')
    expect(rule).toContain('合并人以用户本人为准')
    expect(rule).toContain('除非项目文档明确要求')
    expect(rule).toContain('写明合并人会是谁')
    expect(rule).not.toContain('有自动合并脚本就用它')
  })

  test('a GitHub origin lands the change as a PR with gh; GitLab keeps its words', () => {
    const lane = { kind: 'mr' as const, path: '/r/wt', branch: 'agentd/12-x', repo: '/r' }
    const github = laneRule({ ...lane, forge: 'github' }, 12, 'done', 'ask', 'consent')
    expect(github).toContain('gh pr create --base main --head agentd/12-x')
    expect(github).toContain('--delete-branch')
    expect(github).toContain('项目文档优先')
    expect(github).toContain('gh auth login')
    expect(github).toContain('git ls-remote --heads origin agentd/12-x')
    expect(github).not.toContain('glab')
    expect(github).toContain(openMrText(12, 'agentd/12-x').slice(0, '【奏折 #12 开 MR】'.length))
    const gitlab = laneRule({ ...lane, forge: 'gitlab' }, 12, 'done', 'ask', 'consent')
    expect(gitlab).toBe(laneRule(lane, 12, 'done', 'ask', 'consent'))
    expect(gitlab).not.toContain('gh pr')
  })

  test('a ticket reads as readonly, MR (once its lane is made) or local', () => {
    const base = {
      readonly: false,
      worktree: false,
      worktreePath: null,
      branch: null,
      repoPath: null,
    }
    expect(laneModeOf({ ...base, readonly: true }).kind).toBe('readonly')
    expect(laneModeOf({ ...base, worktree: true }).kind).toBe('local')
    expect(
      laneModeOf({ ...base, worktree: true, worktreePath: '/w', branch: 'b', repoPath: '/r' }),
    ).toEqual({ kind: 'mr', path: '/w', branch: 'b', repo: '/r', forge: 'gitlab' })
    expect(
      laneModeOf(
        { ...base, worktree: true, worktreePath: '/w', branch: 'b', repoPath: '/r' },
        'github',
      ),
    ).toMatchObject({ kind: 'mr', forge: 'github' })
  })
})
