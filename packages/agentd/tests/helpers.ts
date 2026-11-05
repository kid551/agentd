import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SpawnResult, SpawnSpec, WorkerInfo, WorkerRuntime } from '../src/claude.js'
import { DEFAULTS, type Config, type Paths } from '../src/config.js'
import { Daemon } from '../src/daemon.js'
import type { CleanMode, Cleaned, Lane, Lanes, Origin } from '../src/lanes.js'
import { Store } from '../src/store.js'

/** Lanes without git: records what was made and cleaned; the test says what origin has. */
export class FakeLanes implements Lanes {
  created: Lane[] = []
  cleaned: { lane: Lane; mode: CleanMode }[] = []
  /** Branches origin has. */
  remote = new Set<string>()
  failCreate: string | null = null
  keep = false
  /** What a repository's clone says of its origin; unlisted ones are on a GitLab, with main. */
  origins = new Map<string, Origin>()

  probe(repo: string): Origin {
    return this.origins.get(repo) ?? { url: 'ssh://git@gitlab.example:7003/g/p.git', hasBase: true }
  }

  async create(lane: Lane): Promise<void> {
    if (this.failCreate) throw new Error(this.failCreate)
    this.created.push(lane)
  }

  async hasRemoteBranch(lane: Lane): Promise<boolean> {
    return this.remote.has(lane.branch)
  }

  async clean(lane: Lane, mode: CleanMode): Promise<Cleaned> {
    this.cleaned.push({ lane, mode })
    return this.keep
      ? { removed: false, text: `保留了 ${lane.path}` }
      : { removed: true, text: `已清理 ${lane.branch}` }
  }
}

/** A Worker runtime that records spawns and lets the test say what `claude agents` lists. */
export class FakeRuntime implements WorkerRuntime {
  spawns: SpawnSpec[] = []
  stops: string[] = []
  workers: WorkerInfo[] = []
  next: (spec: SpawnSpec) => SpawnResult = spec => ({
    ok: true,
    bgId: `bg${this.spawns.length}${spec.name.slice(-1)}`,
  })

  async spawn(spec: SpawnSpec): Promise<SpawnResult> {
    this.spawns.push(spec)
    const result = this.next(spec)
    if (result.ok) {
      this.workers.push({
        name: spec.name,
        id: result.bgId,
        sessionId: `sess-${spec.name}`,
        cwd: spec.cwd,
        status: 'busy',
        state: undefined,
        pid: 1000 + this.spawns.length,
        startedAt: this.spawns.length,
      })
    }
    return result
  }

  async list(): Promise<WorkerInfo[]> {
    return this.workers
  }

  async stop(bgId: string): Promise<void> {
    this.stops.push(bgId)
  }

  set(name: string, patch: Partial<WorkerInfo>): void {
    this.workers = this.workers.map(w => (w.name === name ? { ...w, ...patch } : w))
  }
}

export type World = {
  daemon: Daemon
  runtime: FakeRuntime
  lanes: FakeLanes
  store: Store
  clock: { now: number }
  root: string
}

/**
 * A daemon over a temp folder with three repositories and a controllable
 * clock. `mr` names the projects whose delivery is `mr`.
 */
export function world(config: Partial<Config> = {}, mr: string[] = []): World {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agentd-test-')))
  const root = join(home, 'repos')
  for (const name of ['memos', 'acme', 'billboard'])
    mkdirSync(join(root, name, '.git'), { recursive: true })
  const projects = Object.fromEntries(
    mr.map(name => [join(root, name), { delivery: 'mr' as const }]),
  )
  const paths: Paths = {
    home,
    db: join(home, 'agentd.db'),
    mcpDir: join(home, 'mcp'),
    logDir: join(home, 'logs'),
    config: join(home, 'config.json'),
  }
  mkdirSync(paths.mcpDir, { recursive: true })
  const clock = { now: 1_000_000 }
  const store = new Store(paths.db, { now: () => clock.now })
  const runtime = new FakeRuntime()
  const lanes = new FakeLanes()
  const daemon = new Daemon({
    store,
    runtime,
    lanes,
    config: {
      ...DEFAULTS,
      roots: [root],
      projects,
      ...config,
      worker: { ...DEFAULTS.worker, ...config.worker },
    },
    paths,
    mcpScript: '/fake/agentd-mcp.mjs',
    now: () => clock.now,
  })
  daemon.rescan()
  return { daemon, runtime, lanes, store, clock, root }
}

/** Waits for the launches a tick started. */
export async function settle(daemon: Daemon): Promise<void> {
  await daemon.tick()
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))
}
