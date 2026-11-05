import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { forgeOf, githubOf, GitLanes, laneFor, whyLocal } from '../src/lanes.js'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'protocol.file.allow=always', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )

/** A bare origin with a `main`, a clone of it as the project, and a submodule repo. */
function repos() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agentd-lanes-')))
  const origin = join(home, 'origin.git')
  const sub = join(home, 'sub')
  git(home, 'init', '-q', '-b', 'main', sub)
  git(sub, 'commit', '-q', '--allow-empty', '-m', 'sub')
  git(home, 'init', '-q', '--bare', '-b', 'main', origin)
  const repo = join(home, 'project')
  git(home, 'clone', '-q', origin, repo)
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  git(repo, 'push', '-q', 'origin', 'HEAD:main')
  return { home, origin, repo, sub }
}

describe('GitLanes', () => {
  test('cuts the lane from a fresh origin/main, not the local HEAD, and reuses it', async () => {
    const { home, origin, repo } = repos()
    // origin moves on; the local checkout stays behind and has a commit of its own.
    const other = join(home, 'other')
    git(home, 'clone', '-q', origin, other)
    writeFileSync(join(other, 'b.txt'), 'b\n')
    git(other, 'add', '.')
    git(other, 'commit', '-q', '-m', 'second')
    git(other, 'push', '-q', 'origin', 'HEAD:main')
    writeFileSync(join(repo, 'local.txt'), 'x\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'local only')

    const lanes = new GitLanes()
    const lane = laneFor(repo, 'agentd', 7, 1234)
    expect(lane.branch).toBe('agentd/7-ya')
    await lanes.create(lane)
    expect(existsSync(join(lane.path, 'b.txt'))).toBe(true)
    expect(existsSync(join(lane.path, 'local.txt'))).toBe(false)
    expect(git(lane.path, 'branch', '--show-current').trim()).toBe('agentd/7-ya')
    await lanes.create(lane)
    expect(git(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(2)
    // The main checkout does not see its lanes, and the exclude line is written once.
    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    await lanes.create(laneFor(repo, 'agentd', 8, 1))
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n').filter(l => l === '/.claude/worktrees/')).toHaveLength(1)
  })

  test('a branch left from before (its worktree gone) is checked out again', async () => {
    const { repo } = repos()
    const lanes = new GitLanes()
    const lane = laneFor(repo, 'agentd', 1, 1)
    await lanes.create(lane)
    writeFileSync(join(lane.path, 'w.txt'), 'w\n')
    git(lane.path, 'add', '.')
    git(lane.path, 'commit', '-q', '-m', 'work')
    git(repo, 'worktree', 'remove', '--force', lane.path)
    await lanes.create(lane)
    expect(existsSync(join(lane.path, 'w.txt'))).toBe(true)
  })

  test('tells whether origin still has the branch', async () => {
    const { repo } = repos()
    const lanes = new GitLanes()
    const lane = laneFor(repo, 'agentd', 2, 2)
    await lanes.create(lane)
    expect(await lanes.hasRemoteBranch(lane)).toBe(false)
    git(lane.path, 'push', '-q', 'origin', `HEAD:refs/heads/${lane.branch}`)
    expect(await lanes.hasRemoteBranch(lane)).toBe(true)
  })

  test('merged: removes a clean lane with an initialised submodule, keeps the commits under refs/trash', async () => {
    const { repo, sub } = repos()
    git(repo, 'submodule', 'add', '-q', sub, 'ext')
    git(repo, 'commit', '-q', '-m', 'sub')
    git(repo, 'push', '-q', 'origin', 'HEAD:main')
    const lanes = new GitLanes()
    const lane = laneFor(repo, 'agentd', 3, 3)
    await lanes.create(lane)
    git(lane.path, 'submodule', 'update', '-q', '--init')
    writeFileSync(join(lane.path, 'c.txt'), 'c\n')
    git(lane.path, 'add', 'c.txt')
    git(lane.path, 'commit', '-q', '-m', 'change')
    const head = git(lane.path, 'rev-parse', 'HEAD').trim()
    // Inside the submodule's own tree: does not count as left-over work.
    writeFileSync(join(lane.path, 'ext', 'overlay.txt'), 'tag\n')

    const cleaned = await lanes.clean(lane, 'merged')
    expect(cleaned.removed).toBe(true)
    expect(existsSync(lane.path)).toBe(false)
    expect(git(repo, 'branch', '--list', lane.branch).trim()).toBe('')
    expect(git(repo, 'rev-parse', `refs/trash/${lane.branch}`).trim()).toBe(head)
  })

  test('merged: a lane with uncommitted work is kept; discard removes it anyway', async () => {
    const { repo } = repos()
    const lanes = new GitLanes()
    const lane = laneFor(repo, 'agentd', 4, 4)
    await lanes.create(lane)
    writeFileSync(join(lane.path, 'a.txt'), 'changed\n')
    const kept = await lanes.clean(lane, 'merged')
    expect(kept).toMatchObject({ removed: false })
    expect(kept.text).toContain('未提交')
    expect(existsSync(lane.path)).toBe(true)
    expect((await lanes.clean(lane, 'discard')).removed).toBe(true)
    expect(existsSync(lane.path)).toBe(false)
  })

  test('a lane already gone (removed by hand) still has its branch cleaned', async () => {
    const { repo } = repos()
    const lanes = new GitLanes()
    const lane = laneFor(repo, 'agentd', 5, 5)
    await lanes.create(lane)
    git(repo, 'worktree', 'remove', lane.path)
    const cleaned = await lanes.clean(lane, 'merged')
    expect(cleaned.removed).toBe(true)
    expect(git(repo, 'branch', '--list', lane.branch).trim()).toBe('')
  })
})

describe('which projects can take MR tickets', () => {
  test('reads a GitHub owner off any form of origin URL; other hosts are not GitHub', () => {
    expect(githubOf('git@github.com:kid551/agentd.git')).toEqual({
      owner: 'kid551',
      name: 'agentd',
    })
    expect(githubOf('https://github.com/someone-else/tool')).toEqual({
      owner: 'someone-else',
      name: 'tool',
    })
    expect(githubOf('ssh://git@ssh.github.com:443/kid551/x.git')).toEqual({
      owner: 'kid551',
      name: 'x',
    })
    expect(githubOf('ssh://git@gitlab.example.com:7003/acme/acme.git')).toBeNull()
    expect(githubOf('git@git.example.org:alice/api.git')).toBeNull()
    expect(githubOf('https://notgithub.com/a/b.git')).toBeNull()
    expect(forgeOf('git@github.com:kid551/agentd.git')).toBe('github')
    expect(forgeOf('ssh://git@gitlab.example.com:7003/acme/acme.git')).toBe('gitlab')
    expect(forgeOf(null)).toBe('gitlab')
  })

  test('no origin, no origin/main, or a GitHub owner off the list keeps a project local', () => {
    const gitlab = 'ssh://git@gitlab.example.com:7003/acme/acme.git'
    const mine = 'git@github.com:kid551/agentd.git'
    const theirs = 'git@github.com:someone-else/tool.git'
    expect(whyLocal({ url: gitlab, hasBase: true }, ['kid551'])).toBeNull()
    expect(whyLocal({ url: mine, hasBase: true }, ['kid551'])).toBeNull()
    expect(whyLocal({ url: mine, hasBase: true }, ['KID551'])).toBeNull()
    expect(whyLocal({ url: null, hasBase: false }, [])).toContain('没有 origin')
    expect(whyLocal({ url: mine, hasBase: false }, ['kid551'])).toContain('origin/main')
    expect(whyLocal({ url: theirs, hasBase: true }, ['kid551'])).toContain('someone-else')
    // An empty list puts no limit on GitHub owners.
    expect(whyLocal({ url: theirs, hasBase: true }, [])).toBeNull()
  })

  test('probes a clone for its origin and origin/main without asking origin', () => {
    const { home, origin, repo } = repos()
    expect(new GitLanes().probe(repo)).toEqual({ url: origin, hasBase: true })
    const bare = join(home, 'alone')
    git(home, 'init', '-q', '-b', 'main', bare)
    expect(new GitLanes().probe(bare)).toEqual({ url: null, hasBase: false })
    expect(new GitLanes().probe(join(home, 'missing'))).toEqual({ url: null, hasBase: false })
  })
})
