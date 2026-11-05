import { appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { ROUTER_PROMPT, workerPrompt } from '../core/text.js'
import { Board } from './board.js'
import {
  dshRouter,
  dshWorkers,
  type DshAgent,
  type DshContext,
  type Disposer,
  type Log,
} from './dsh.js'
import { routes } from './http.js'
import { DEFAULT_CONFIG, SuperAgentService } from './service.js'
import { openDomainTables, type StorageDomainService } from './tables.js'
import { routerTools, workerTools } from './tools.js'

/** Cordis plugin name. */
export const name = 'superagent'

/**
 * Required dsh services. Cordis throws on reading a service that is not listed
 * here, so every service the plugin touches must be named.
 */
export const inject = [
  'agents',
  'sessionController',
  'storageDomain',
  'webServer',
  'connection',
  'workspaceRegistry',
]

export type PluginConfig = {
  /** Folders scanned for git repositories, besides the registered dsh Workspaces. */
  roots?: string[]
  scanDepth?: number
  maxConcurrent?: number
  workerPreset?: string
  routerPreset?: string
  /** The Router's working directory (it reads no code; this only places it in the sidebar). */
  routerCwd?: string
  stallSeconds?: number
  /** Where the plugin also writes its own log lines; the Host's log goes to stdout only. */
  logFile?: string
  /**
   * Per repository or folder path (the nearest key wins): `mr` projects give
   * every writing ticket its own worktree and send the change to main through
   * an MR, so their Workers run side by side.
   */
  projects?: Record<string, { delivery: 'mr' | 'local' }>
  /** For a repository no `projects` key covers; `local` when absent. */
  defaultDelivery?: 'mr' | 'local'
}

const expandHome = (p: string): string =>
  p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(p)

const ROUTER_PROMPT_ORDER = 900

/** Logs to the Host logger and appends to a file, so problems are readable after the fact. */
function pluginLog(ctx: DshContext, file: string): Log {
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch {
    // the Host logger still gets every line
  }
  const write = (level: string, text: string): void => {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`)
    } catch {
      // best effort
    }
  }
  return {
    info(text) {
      ctx.logger.info(`superagent: ${text}`)
      write('INFO', text)
    },
    warn(text) {
      ctx.logger.warn(`superagent: ${text}`)
      write('WARN', text)
    },
  }
}

export async function apply(ctx: DshContext, config: PluginConfig = {}): Promise<void> {
  const log = pluginLog(ctx, expandHome(config.logFile ?? '~/.dsh/superagent/plugin.log'))
  const opened = await openDomainTables(ctx.storageDomain as unknown as StorageDomainService)
  ctx.effect(() => () => opened.close(), 'superagent: storage')
  const board = new Board(opened.tables)

  const routerPreset = config.routerPreset ?? 'superagent-router'
  const routerLink = dshRouter(
    ctx,
    {
      cwd: expandHome(config.routerCwd ?? '~/.dsh/superagent/router'),
      preset: routerPreset,
      get: () => board.meta().routerSessionId,
      set: id => board.setMeta({ routerSessionId: id }),
    },
    log,
  )
  const service = new SuperAgentService(
    board,
    dshWorkers(ctx, log, () => board.meta().routerSessionId),
    routerLink,
    {
      ...DEFAULT_CONFIG,
      roots: (config.roots ?? ['~/code', '~/project']).map(expandHome),
      scanDepth: config.scanDepth ?? DEFAULT_CONFIG.scanDepth,
      maxConcurrent: config.maxConcurrent ?? DEFAULT_CONFIG.maxConcurrent,
      workerPreset: config.workerPreset ?? DEFAULT_CONFIG.workerPreset,
      stallMs: (config.stallSeconds ?? DEFAULT_CONFIG.stallMs / 1000) * 1000,
      projects: Object.fromEntries(
        Object.entries(config.projects ?? {}).map(([path, value]) => {
          const full = expandHome(path)
          return [existsSync(full) ? realpathSync(full) : full, value]
        }),
      ),
      defaultDelivery: config.defaultDelivery === 'mr' ? 'mr' : 'local',
    },
    () =>
      // A Workspace whose folder was deleted stays registered in dsh; a
      // Worker cannot start there, so it is not offered.
      ctx.workspaceRegistry
        .list()
        .filter(w => existsSync(w.path))
        .map(w => ({
          id: w.title ?? basename(w.path),
          path: w.path,
          root: w.path,
        })),
  )

  /**
   * Runs plugin work after the current dsh dispatch has returned, and never
   * lets it throw into dsh. dsh notifies `session/event` listeners while the
   * Session is still publishing the event, and a Session refuses a second
   * append until that publication ends (reentering crashed the Host). An
   * unhandled rejection is fatal to the Host too, so every failure ends here.
   */
  const later = (label: string, work: () => unknown): void => {
    setImmediate(() => {
      Promise.resolve()
        .then(work)
        .catch(error =>
          log.warn(
            `${label}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
          ),
        )
    })
  }

  // ── Per-agent installation ────────────────────────────────────────────
  // Tools and prompt sections go onto the agent's own scope, whoever created
  // or resumed it (this plugin, the session controller on cold resume, a UI
  // open). Disposers are kept so a reload of this plugin takes them back.
  const installed = new Map<string, Disposer[]>()
  const roleOf = (agent: DshAgent): 'router' | 'worker' | undefined => {
    if (agent.id === board.meta().routerSessionId) return 'router'
    return board.bySession(agent.id) === undefined ? undefined : 'worker'
  }
  const install = (agent: DshAgent): void => {
    if (installed.has(agent.id)) return
    const role = roleOf(agent)
    if (role === undefined) return
    const disposers: Disposer[] = []
    const a = agent.ctx
    if (role === 'router') {
      for (const tool of routerTools(service)) disposers.push(a.tools.register(tool))
      disposers.push(
        a.systemPrompt.section({
          name: 'superagent:router',
          order: ROUTER_PROMPT_ORDER,
          text: ROUTER_PROMPT,
          interpolate: false,
        }),
      )
    } else {
      const ticket = board.bySession(agent.id)
      if (ticket === undefined) return
      for (const tool of workerTools(service)) disposers.push(a.tools.register(tool))
      disposers.push(
        a.systemPrompt.section({
          name: 'superagent:worker',
          order: ROUTER_PROMPT_ORDER,
          text: workerPrompt(ticket),
          interpolate: false,
        }),
      )
      disposers.push(...mirrorInteractions(agent))
    }
    installed.set(agent.id, disposers)
    log.info(`installed ${role} tools on ${agent.id}`)
  }

  /** D3: dsh draws questions and approvals in the Worker's Session; this only watches. */
  const mirrorInteractions = (agent: DshAgent): Disposer[] => {
    const watch =
      (kind: 'question' | 'approval', summarize: (req: Record<string, unknown>) => string) =>
      async (req: Record<string, unknown>, next: () => Promise<unknown>) => {
        later('asked', () => service.asked(agent.id, kind, summarize(req)))
        try {
          return await next()
        } finally {
          later('settled', () => service.settled(agent.id))
        }
      }
    return [
      agent.ctx.on(
        'user-questions/request',
        watch('question', req => {
          const qs = (req.questions as { question?: string }[] | undefined) ?? []
          return (
            qs
              .map(q => q.question ?? '')
              .filter(Boolean)
              .join('；') || '有一个问题'
          )
        }) as never,
        true,
      ),
      agent.ctx.on(
        'approval/request',
        watch('approval', req => {
          const tool =
            typeof req.tool === 'string'
              ? req.tool
              : ((req.tool as { name?: string } | undefined)?.name ?? '某个工具')
          return `审批：${tool}${typeof req.reason === 'string' ? `（${req.reason}）` : ''}`
        }) as never,
        true,
      ),
    ]
  }

  ctx.effect(() => {
    const off = ctx.on('agent/created', ((payload: { agent: DshAgent }) =>
      install(payload.agent)) as never)
    return off
  }, 'superagent: agent/created')
  ctx.effect(() => {
    const off = ctx.on('agent/disposed', ((payload: { agent: DshAgent }) => {
      installed.delete(payload.agent.id)
    }) as never)
    return off
  }, 'superagent: agent/disposed')
  ctx.effect(
    () => () => {
      for (const disposers of installed.values()) for (const d of disposers) d()
      installed.clear()
    },
    'superagent: scoped tools',
  )
  // Agents already live when this plugin (re)loads.
  for (const agent of ctx.agents.list()) install(agent)

  // ── Observers ─────────────────────────────────────────────────────────
  ctx.effect(
    () =>
      ctx.on('agent/status', ((payload: { agent: DshAgent; status: 'idle' | 'running' }) => {
        const { agent, status } = payload
        later('agent/status', () => {
          if (agent.id === board.meta().routerSessionId) {
            if (status === 'idle') return service.flush()
            return
          }
          if (board.bySession(agent.id) !== undefined) service.workerStatus(agent.id, status)
        })
      }) as never),
    'superagent: agent/status',
  )
  ctx.effect(
    () =>
      ctx.on('session/event', ((
        session: { id: string },
        event: { type: string; data: Record<string, unknown> },
      ) => {
        const sessionId = session.id
        later('session/event', () => observe(sessionId, event))
      }) as never),
    'superagent: session/event',
  )

  const observe = (
    sessionId: string,
    event: { type: string; data: Record<string, unknown> },
  ): Promise<unknown> | void => {
    const isRouter = sessionId === board.meta().routerSessionId
    if (isRouter) {
      if (event.type === 'compaction/end') return service.routerCompacted()
      if (event.type === 'user/message' && sourceKind(event.data) === 'user') {
        return service.routerHeardUser()
      }
      return
    }
    if (board.bySession(sessionId) === undefined) return
    if (event.type === 'tool/call') {
      const name = String(event.data.name ?? '').replace(/^superagent_/, '')
      service.noteActivity(sessionId, `▸ ${name}${argHint(event.data.args ?? event.data.input)}`)
    } else if (event.type === 'assistant/message') {
      const first = textOf((event.data.message as { content?: unknown })?.content).split('\n')[0]
      if (first) service.noteActivity(sessionId, first.slice(0, 120))
    } else if (event.type === 'user/message') {
      const kind = sourceKind(event.data)
      if (kind === 'user') return service.userSaid(sessionId, textOf(event.data.content))
      if (kind === 'user-question-reply') return service.settled(sessionId)
    }
  }

  // ── HTTP for the browser half ─────────────────────────────────────────
  for (const route of routes(
    service,
    () => board.meta().routerSessionId,
    () => routerLink.ensure(),
    req => ctx.connection.admit(req),
  )) {
    ctx.effect(() => ctx.webServer.register(route), `superagent: ${route.path}`)
  }

  // ── Watchdog and Router creation ─────────────────────────────────────
  await service.reconcile()
  void routerLink.ensure().then(
    id => {
      const agent = ctx.agents.get(id)
      if (agent !== undefined) install(agent)
    },
    error => log.warn(`router session: ${String(error)}`),
  )
  ctx.effect(() => {
    const timer = setInterval(() => {
      service.tick().catch(error => log.warn(`tick: ${String(error)}`))
    }, 3000)
    return () => clearInterval(timer)
  }, 'superagent: watchdog')
  log.info(
    `ready; router ${board.meta().routerSessionId ?? '(creating)'}, ${board.list().length} tickets`,
  )
}

function sourceKind(message: Record<string, unknown>): string | undefined {
  const source = message.source as { kind?: string } | undefined
  return source?.kind
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } => (b as { type?: string })?.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim()
}

const HINT_KEYS = [
  'description',
  'command',
  'path',
  'file_path',
  'pattern',
  'url',
  'query',
  'summary',
  'text',
]

function argHint(args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  for (const key of HINT_KEYS) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim() !== '')
      return ` ${value.replace(/\s+/g, ' ').slice(0, 100)}`
  }
  return ''
}
