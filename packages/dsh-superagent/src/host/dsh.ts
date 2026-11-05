import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'

import type { Delivery, Liveness, RouterLink, WorkerRuntime } from './runtime.js'

// The structural slice of the dsh services this plugin uses. Written against
// the installed 0.2.1-rc.5 packages; see implementation-notes.md (dsh section)
// for where each shape was read.

export type TextBlock = { type: 'text'; text: string }
export type MessageSource = Record<string, unknown> & { kind: string }
export type UserMessage = { id: string; role: 'user'; content: TextBlock[]; source: MessageSource }

export type DshAgent = {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly ctx: DshContext
  readonly session: {
    deriveMessages(): {
      role: string
      content: readonly { type: string; text?: string; name?: string }[]
    }[]
  }
  cancel(cause: { kind: 'user' }, options?: { keepInbox?: boolean }): void
  followup(message: UserMessage): void
  steer(message: UserMessage): void
  inject(message: UserMessage): void
}

export type Disposer = () => unknown

export type DshContext = {
  on(name: string, listener: (...args: never[]) => unknown, prepend?: boolean): Disposer
  effect(run: () => Disposer | undefined | void, label?: string): void
  get(name: string): unknown
  logger: {
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }
  tools: { register(tool: unknown): Disposer }
  systemPrompt: {
    section(section: { name: string; order: number; text: string; interpolate?: boolean }): Disposer
  }
  agents: { get(id: string): DshAgent | undefined; list(): DshAgent[] }
  sessionController: {
    create(request: {
      cwd?: string
      sessionId?: string
      agentPreset?: string
    }): Promise<{ sessionId: string }>
    resolveAgent(id: string): Promise<{ agent: DshAgent } | { error: unknown }>
  }
  workspaceRegistry: {
    create(
      path: string,
      title?: string,
    ): Promise<{ id: string; attachSession(id: string): Promise<unknown> }>
    list(): { id: string; path: string; title?: string }[]
  }
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler(
        req: import('node:http').IncomingMessage,
        res: import('node:http').ServerResponse,
      ): unknown
    }): Disposer
  }
  storageDomain: { open(spec: unknown): Promise<never> }
  connection: {
    admit(req: import('node:http').IncomingMessage): { peer: unknown } | { rejection: number }
  }
}

export type Log = { info(text: string): void; warn(text: string): void }

const text = (t: string): TextBlock[] => [{ type: 'text', text: t }]

/** A message the Router sent to a Worker: dsh's agent-message relay. */
function relayMessage(body: string, routerId: string | undefined): UserMessage {
  const source: MessageSource =
    routerId === undefined
      ? {
          kind: 'webhook',
          provider: 'superagent',
          source: 'superagent',
          deliveryId: randomUUID(),
          ruleId: 'worker',
          form: 'notice',
          summary: body.slice(0, 80),
        }
      : { kind: 'agent-message', form: 'relay', senderSessionId: routerId }
  return { id: randomUUID(), role: 'user', content: text(body), source }
}

/** A notice from this plugin: rendered by the chat as「收到外部事件」. */
function noticeMessage(body: string, summary: string): UserMessage {
  return {
    id: randomUUID(),
    role: 'user',
    content: text(body),
    source: {
      kind: 'webhook',
      provider: 'superagent',
      source: 'superagent',
      deliveryId: randomUUID(),
      ruleId: 'digest',
      form: 'notice',
      summary,
    },
  }
}

async function live(ctx: DshContext, log: Log, sessionId: string): Promise<DshAgent | undefined> {
  const now = ctx.agents.get(sessionId)
  if (now !== undefined) return now
  try {
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    return 'agent' in resolved ? resolved.agent : undefined
  } catch (error) {
    log.warn(`cannot resume ${sessionId}: ${String(error)}`)
    return undefined
  }
}

function deliverTo(agent: DshAgent, message: UserMessage, mode: Delivery): void {
  if (mode === 'inject') agent.inject(message)
  else if (mode === 'steer' && agent.status === 'running') agent.steer(message)
  else agent.followup(message)
}

function liveness(ctx: DshContext, sessionId: string | undefined): Liveness {
  if (sessionId === undefined) return 'gone'
  const agent = ctx.agents.get(sessionId)
  return agent === undefined ? 'gone' : agent.status
}

export function dshWorkers(
  ctx: DshContext,
  log: Log,
  routerId: () => string | undefined,
): WorkerRuntime {
  return {
    async create({ sessionId, cwd, preset }) {
      // Created through the session controller, like a session the person
      // starts in the UI: it owns the Agent (so a reload of this plugin leaves
      // Workers running) and installs the model selection the UI reads.
      await ctx.sessionController.create({ cwd, sessionId, agentPreset: preset })
      // Sessions group under the Workspace of their cwd; register the project
      // as a Workspace so the Worker shows up in the sidebar.
      try {
        const ws = await ctx.workspaceRegistry.create(cwd)
        await ws.attachSession(sessionId)
      } catch (error) {
        log.warn(`workspace for ${cwd}: ${String(error)}`)
      }
    },
    async send(sessionId, body, mode) {
      const agent = await live(ctx, log, sessionId)
      if (agent === undefined) return false
      deliverTo(agent, relayMessage(body, routerId()), mode)
      return true
    },
    async cancel(sessionId) {
      ctx.agents.get(sessionId)?.cancel({ kind: 'user' }, { keepInbox: false })
    },
    status: sessionId => liveness(ctx, sessionId),
    async transcript(sessionId, maxChars) {
      const agent = await live(ctx, log, sessionId)
      if (agent === undefined) return '会话打不开。'
      const lines: string[] = []
      for (const m of agent.session.deriveMessages()) {
        for (const block of m.content) {
          if (block.type === 'text' && block.text) lines.push(`${m.role}: ${block.text}`)
          else if (block.type === 'tool-call' && block.name)
            lines.push(`${m.role}: ▸ ${block.name}`)
        }
      }
      const all = lines.join('\n')
      return all.length > maxChars ? `…${all.slice(-maxChars)}` : all || '会话是空的。'
    },
  }
}

export function dshRouter(
  ctx: DshContext,
  input: {
    cwd: string
    preset: string
    get(): string | undefined
    set(id: string): Promise<unknown>
  },
  log: Log,
): RouterLink {
  let creating: Promise<string> | undefined
  // Once per plugin load: a Router created before its Workspace could be
  // registered (or whose Workspace was removed) is put back in the sidebar.
  // `create` returns the existing Workspace and `attachSession` is idempotent.
  let attached: string | undefined
  const attach = async (sessionId: string): Promise<void> => {
    if (attached === sessionId) return
    try {
      const ws = await ctx.workspaceRegistry.create(input.cwd, 'Super-agent')
      await ws.attachSession(sessionId)
      attached = sessionId
    } catch (error) {
      log.warn(`router workspace: ${String(error)}`)
    }
  }
  const ensure = async (): Promise<string> => {
    const known = input.get()
    if (known !== undefined) {
      await attach(known)
      return known
    }
    creating ??= (async () => {
      await mkdir(input.cwd, { recursive: true })
      const sessionId = `session-${randomUUID()}`
      await input.set(sessionId)
      await ctx.sessionController.create({ cwd: input.cwd, sessionId, agentPreset: input.preset })
      await attach(sessionId)
      return sessionId
    })().finally(() => {
      creating = undefined
    })
    return creating
  }
  return {
    ensure,
    status: () => liveness(ctx, input.get()),
    async deliver(body, summary) {
      const agent = await live(ctx, log, await ensure())
      if (agent === undefined) return false
      agent.followup(noticeMessage(body, summary))
      return true
    },
    async note(body) {
      const id = input.get()
      if (id === undefined) return false
      const agent = ctx.agents.get(id)
      if (agent === undefined) return false
      agent.inject(noticeMessage(body, body.slice(0, 80)))
      return true
    },
  }
}
