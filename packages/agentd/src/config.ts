import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export type Config = {
  /** Folders scanned for git repositories that Workers may be sent to. */
  roots: string[]
  port: number
  /** How deep below a root a repository's `.git` may sit. */
  scanDepth: number
  worker: { model: string; permissionMode: string; maxConcurrent: number }
  router: { inlineChars: number }
  /** Seconds a Worker may sit idle in `working` before the ticket counts as stalled. */
  stallSeconds: number
  /** Exit after this many seconds with no live ticket and no request; 0 never. */
  idleExitSeconds: number
  /**
   * How a writing ticket reaches main, keyed by a repository's path or by a
   * folder of them: the key nearest the repository wins. `mr` projects give
   * every writing ticket its own worktree and send the change to main through
   * an MR, so their Workers run side by side. `local` ones take one writing
   * Worker at a time, in the project folder, on its current branch.
   */
  projects: Record<string, { delivery: Delivery }>
  /** For a repository no `projects` key covers. */
  defaultDelivery: Delivery
  /**
   * GitHub accounts and organisations the person pushes to. When listed, a
   * github.com repository owned by anyone else stays local even if set to `mr`
   * (a clone of someone else's project could never land its MR). Empty: no limit.
   */
  githubOwners: string[]
}

export type Delivery = 'mr' | 'local'

export type Paths = { home: string; db: string; mcpDir: string; logDir: string; config: string }

export const DEFAULTS: Config = {
  roots: ['~/code'],
  port: 7707,
  scanDepth: 3,
  worker: { model: 'opus', permissionMode: 'auto', maxConcurrent: 4 },
  router: { inlineChars: 300 },
  stallSeconds: 45,
  idleExitSeconds: 0,
  projects: {},
  defaultDelivery: 'local',
  githubOwners: [],
}

export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return resolve(path)
}

/** `AGENTD_HOME` moves everything (tests use a temp folder); default `~/.agentd`. */
export function agentdPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.AGENTD_HOME ? expandHome(env.AGENTD_HOME) : join(homedir(), '.agentd')
  return {
    home,
    db: join(home, 'agentd.db'),
    mcpDir: join(home, 'mcp'),
    logDir: join(home, 'logs'),
    config: join(home, 'config.json'),
  }
}

export function ensureDirs(paths: Paths): void {
  for (const dir of [paths.home, paths.mcpDir, paths.logDir]) mkdirSync(dir, { recursive: true })
}

/** Reads the config file over the defaults; a missing file is the defaults. */
export function loadConfig(paths: Paths, override: Partial<Config> = {}): Config {
  let fromFile: Partial<Config> = {}
  if (existsSync(paths.config)) {
    fromFile = JSON.parse(readFileSync(paths.config, 'utf8')) as Partial<Config>
  }
  const merged: Config = {
    ...DEFAULTS,
    ...fromFile,
    ...override,
    worker: { ...DEFAULTS.worker, ...fromFile.worker, ...override.worker },
    router: { ...DEFAULTS.router, ...fromFile.router, ...override.router },
  }
  return { ...merged, roots: merged.roots.map(expandHome), projects: byRealPath(merged.projects) }
}

/** Keys compared with the scanner's paths, which are real paths. */
function byRealPath(projects: Config['projects']): Config['projects'] {
  return Object.fromEntries(
    Object.entries(projects).map(([path, value]) => {
      const full = expandHome(path)
      return [existsSync(full) ? realpathSync(full) : full, value]
    }),
  )
}

export const deliveryOf = (config: Config, projectPath: string): Delivery =>
  matchDelivery(config.projects, config.defaultDelivery, projectPath)

/**
 * The delivery of the key nearest `path`: the repository's own, else the
 * closest folder above it, else `fallback`. Keys are whole path segments, so
 * `~/a/acme` never covers `~/a/acme-flutter`.
 */
export function matchDelivery(
  projects: Record<string, { delivery: Delivery }>,
  fallback: Delivery,
  path: string,
): Delivery {
  let best: { length: number; delivery: Delivery } | undefined
  for (const [key, { delivery }] of Object.entries(projects)) {
    const base = key.endsWith(sep) ? key.slice(0, -1) : key
    if (path !== base && !path.startsWith(base + sep)) continue
    if (best === undefined || base.length > best.length) best = { length: base.length, delivery }
  }
  return (best?.delivery ?? fallback) === 'mr' ? 'mr' : 'local'
}
