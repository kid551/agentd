import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

// A lane is one ticket's own git worktree and branch, cut from a fresh
// origin/main, so Workers that write to the same project never wait on each
// other. Both hosts (agentd, dsh-superagent) use this module; each names its
// lanes with its own prefix, so two hosts numbering from 1 never collide.

export type Lane = {
  /** The project's main checkout. */
  repo: string
  /** The worktree folder, under `<repo>/.claude/worktrees/`. */
  path: string
  branch: string
}

export type CleanMode =
  /** Merged: keep the worktree if it still holds uncommitted work. */
  | 'merged'
  /** The person gave the work up (or there was none): remove whatever is there. */
  | 'discard'

export type Cleaned = { removed: boolean; text: string }

/** What a repository's own clone says about its origin, without asking origin. */
export type Origin = {
  url: string | null
  /** The clone has `refs/remotes/origin/main`. */
  hasBase: boolean
}

/** Where an MR goes: GitHub (a PR, with gh) or, for any other host, a GitLab. */
export type Forge = 'github' | 'gitlab'

/** What the hosts need from git; tests give a fake. */
export interface Lanes {
  /** Read locally, at once: tickets are dispatched without waiting on the network. */
  probe(repo: string): Origin
  /** Makes the worktree and branch; a lane already there is reused. */
  create(lane: Lane): Promise<void>
  /** Whether origin still has the lane's branch. Throws when origin cannot be asked. */
  hasRemoteBranch(lane: Lane): Promise<boolean>
  /** Removes the worktree and the local branch, leaving the branch's commits under `refs/trash/`. */
  clean(lane: Lane, mode: CleanMode): Promise<Cleaned>
}

/** The branch lanes are cut from and merged back to. */
export const BASE = 'main'

/** Where lanes live in a project, as an exclude pattern. */
const LANES_DIR = '/.claude/worktrees/'

/**
 * Names a ticket's lane. The stamp (the ticket's creation time) keeps names
 * unique when a host's numbering starts over (a reset database).
 */
export function laneFor(repo: string, prefix: string, id: number, stamp: number): Lane {
  const tag = `${id}-${stamp.toString(36)}`
  return {
    repo,
    path: join(repo, '.claude', 'worktrees', `${prefix}-${tag}`),
    branch: `${prefix}/${tag}`,
  }
}

export type GitResult = { code: number; stdout: string; stderr: string }
export type GitRun = (args: string[], cwd: string) => Promise<GitResult>

const GIT_TIMEOUT_MS = 60_000

export const runGit: GitRun = (args, cwd) =>
  new Promise(resolve => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr || (error && !stdout ? error.message : '')),
        })
      },
    )
  })

const real = (path: string): string => (existsSync(path) ? realpathSync(path) : path)

/** A git command run in place, for a quick local read; null when it fails. */
function gitNow(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

export function probeOrigin(repo: string): Origin {
  if (!existsSync(repo)) return { url: null, hasBase: false }
  const url = gitNow(['config', '--get', 'remote.origin.url'], repo)?.trim() || null
  const hasBase =
    url !== null &&
    gitNow(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${BASE}`], repo) !== null
  return { url, hasBase }
}

/** The owner and name of a github.com repository an origin URL points at; null for other hosts. */
export function githubOf(url: string): { owner: string; name: string } | null {
  const m =
    /^(?:[^@/\s]+@)?(?:ssh\.)?github\.com:(?!\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url) ??
    /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?(?:ssh\.)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      url,
    )
  return m ? { owner: m[1] as string, name: m[2] as string } : null
}

export const forgeOf = (url: string | null): Forge =>
  url !== null && githubOf(url) !== null ? 'github' : 'gitlab'

/**
 * Why a project set to `mr` must still take its writing tickets in its own
 * folder, one at a time; null when it can take MR tickets. An MR needs an
 * origin with a `main` to cut lanes from, and, on GitHub, an owner the person
 * can push to: `owners` lists them, and an empty list does not limit.
 */
export function whyLocal(origin: Origin, owners: string[]): string | null {
  if (origin.url === null) return '仓库没有 origin'
  if (!origin.hasBase) return `本地没有 origin/${BASE}`
  const github = githubOf(origin.url)
  const listed = new Set(owners.map(o => o.toLowerCase()))
  if (github && listed.size > 0 && !listed.has(github.owner.toLowerCase()))
    return `GitHub 上的 ${github.owner} 不在 githubOwners 里`
  return null
}

export class GitLanes implements Lanes {
  constructor(private readonly git: GitRun = runGit) {}

  probe(repo: string): Origin {
    return probeOrigin(repo)
  }

  private async must(args: string[], cwd: string): Promise<string> {
    const r = await this.git(args, cwd)
    if (r.code !== 0)
      throw new Error(`git ${args.join(' ')} 失败（${r.code}）：${r.stderr.trim().slice(0, 400)}`)
    return r.stdout
  }

  private async hasBranch(lane: Lane): Promise<boolean> {
    const r = await this.git(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${lane.branch}`],
      lane.repo,
    )
    return r.code === 0
  }

  /** The lane's worktree is registered in the repository, on the lane's branch. */
  private async isRegistered(lane: Lane): Promise<boolean> {
    if (!existsSync(lane.path)) return false
    const list = await this.must(['worktree', 'list', '--porcelain'], lane.repo)
    const want = real(lane.path)
    return list.split('\n\n').some(entry => {
      const lines = entry.split('\n')
      const path = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length)
      return (
        path !== undefined &&
        real(path) === want &&
        lines.includes(`branch refs/heads/${lane.branch}`)
      )
    })
  }

  async create(lane: Lane): Promise<void> {
    // A relaunch or a retry after a failed start comes here again.
    if (await this.isRegistered(lane)) return
    await this.must(['fetch', 'origin', BASE], lane.repo)
    await this.exclude(lane.repo)
    mkdirSync(dirname(lane.path), { recursive: true })
    const args = (await this.hasBranch(lane))
      ? ['worktree', 'add', lane.path, lane.branch]
      : ['worktree', 'add', '-b', lane.branch, lane.path, `origin/${BASE}`]
    await this.must(args, lane.repo)
  }

  /**
   * Keeps lanes out of the main checkout's `git status` in a project that does
   * not ignore `.claude/` itself. `info/exclude` is the clone's own, never committed.
   */
  private async exclude(repo: string): Promise<void> {
    const dir = (await this.must(['rev-parse', '--git-common-dir'], repo)).trim()
    const file = join(isAbsolute(dir) ? dir : join(repo, dir), 'info', 'exclude')
    const now = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (now.split('\n').includes(LANES_DIR)) return
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${now === '' || now.endsWith('\n') ? '' : '\n'}${LANES_DIR}\n`)
  }

  async hasRemoteBranch(lane: Lane): Promise<boolean> {
    const out = await this.must(['ls-remote', '--heads', 'origin', lane.branch], lane.repo)
    return out.trim() !== ''
  }

  async clean(lane: Lane, mode: CleanMode): Promise<Cleaned> {
    const done: string[] = []
    if (existsSync(lane.path)) {
      if (mode === 'merged') {
        // Changes inside a submodule's own tree (a dev overlay tag) do not count;
        // a moved submodule pointer does.
        const dirty = await this.git(
          ['status', '--porcelain', '--ignore-submodules=dirty'],
          lane.path,
        )
        if (dirty.code !== 0)
          return { removed: false, text: `保留了 ${lane.path}：读不出它的 git 状态` }
        if (dirty.stdout.trim() !== '') {
          return {
            removed: false,
            text: `保留了 ${lane.path}：合入后它还有未提交的改动（${dirty.stdout.trim().split('\n').length} 个文件），请看过再手动删`,
          }
        }
      }
      // --force: git refuses any worktree with initialised submodules without it,
      // clean or not. Whether it may go was decided above.
      const removed = await this.git(['worktree', 'remove', '--force', lane.path], lane.repo)
      if (removed.code !== 0) {
        return {
          removed: false,
          text: `保留了 ${lane.path}：git worktree remove 失败：${removed.stderr.trim().slice(0, 200)}`,
        }
      }
      done.push(`worktree ${lane.path}`)
    }
    await this.git(['worktree', 'prune'], lane.repo)
    if (await this.hasBranch(lane)) {
      const head = (await this.must(['rev-parse', `refs/heads/${lane.branch}`], lane.repo)).trim()
      // -D, not -d: a squash merge never makes the branch an ancestor of main.
      // The commits stay reachable here, so deleting loses nothing.
      await this.must(['update-ref', `refs/trash/${lane.branch}`, head], lane.repo)
      await this.must(['branch', '-D', lane.branch], lane.repo)
      done.push(`分支 ${lane.branch}（提交备份在 refs/trash/${lane.branch}）`)
    }
    return {
      removed: true,
      text: done.length > 0 ? `已清理 ${done.join('、')}` : '没有要清理的 worktree 或分支',
    }
  }
}
