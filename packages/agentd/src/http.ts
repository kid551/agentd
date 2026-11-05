import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { Daemon } from './daemon.js'
import type { ApplyResult } from './store.js'
import type { Outcome } from './types.js'

type Handler = (req: Request) => Promise<Reply> | Reply
type Request = { params: string[]; query: URLSearchParams; body: Record<string, unknown> }
type Reply = { status?: number; body: unknown }

const MAX_BODY = 1024 * 1024
const MAX_WAIT_MS = 30_000

const OUTCOMES: Outcome[] = ['ready', 'blocked', 'failed', 'dropped', 'merged']

const MAX_SCRIPT = 16 * 1024 * 1024

/** A bundle's content hash; '' when it isn't a readable file of bundle size. */
export function scriptHash(path: string): string {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_SCRIPT) return ''
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return ''
  }
}

/**
 * Whether the bundle at `script` differs from the one this process booted
 * from. By content, not path or mtime: an installed plugin keeps each version
 * in its own cache folder, so a new version is a different file while the one
 * the daemon runs stays as it was.
 */
export function isStaleBuild(bootHash: string, script: string): boolean {
  return bootHash !== '' && scriptHash(script) !== bootHash
}

const BOOT_SCRIPT = process.argv[1] as string
const BOOT_HASH = scriptHash(BOOT_SCRIPT)

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const str = (body: Record<string, unknown>, key: string): string => {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `缺少字段 ${key}`)
  return value
}

const id = (params: string[]): number => {
  const n = Number(params[0])
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'ticket 号无效')
  return n
}

const waitMs = (query: URLSearchParams): number =>
  Math.min(MAX_WAIT_MS, Math.max(0, Number(query.get('wait') ?? 0) * 1000))

/** A row count from the query, `fallback` when absent or not a number, at most 500. */
const count = (query: URLSearchParams, key: string, fallback: number): number => {
  const n = Number(query.get(key) ?? fallback)
  return Number.isInteger(n) && n > 0 ? Math.min(n, 500) : fallback
}

/** A state change answers 200 with the ticket, or 409 with the reason it was refused. */
const applied = (result: ApplyResult): Reply =>
  result.ok
    ? { body: { ok: true, ticket: result.ticket } }
    : {
        status: result.ticket ? 409 : 404,
        body: { ok: false, reason: result.reason, ticket: result.ticket },
      }

export function routes(daemon: Daemon, shutdown?: () => void): [string, RegExp, Handler][] {
  const { store } = daemon
  return [
    [
      'GET',
      /^\/status$/,
      ({ query }) => ({
        body: {
          ok: true,
          pid: process.pid,
          /** True once `?script=` (the caller's bundle; default: our own file) differs from the one running. */
          isStale: isStaleBuild(BOOT_HASH, query.get('script') ?? BOOT_SCRIPT),
          lastEventId: store.lastEventId(),
          needsMe: store.listTickets('needs_me').length,
          open: store.listTickets('open').length,
          projects: store.listProjects().length,
        },
      }),
    ],
    [
      'POST',
      /^\/shutdown$/,
      () => {
        if (!shutdown) throw new HttpError(409, '这个 agentd 不能被远程关闭')
        // Reply first; the exit follows once the response is flushed.
        setTimeout(shutdown, 50).unref()
        return { body: { ok: true } }
      },
    ],
    ['GET', /^\/projects$/, () => ({ body: store.listProjects() })],
    ['POST', /^\/projects\/rescan$/, () => ({ body: daemon.rescan() })],
    [
      'GET',
      /^\/tickets$/,
      ({ query }) => {
        const filter = (query.get('state') ?? 'open') as 'open' | 'needs_me' | 'recent' | 'all'
        return { body: store.listTickets(filter) }
      },
    ],
    [
      'POST',
      /^\/tickets$/,
      ({ body }) => {
        const result = daemon.dispatch({
          project: str(body, 'project'),
          title: str(body, 'title'),
          prompt: str(body, 'prompt'),
          readonly: body.readonly === true,
          ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
        })
        return result.ok ? { status: 201, body: result } : { status: 422, body: result }
      },
    ],
    [
      'GET',
      /^\/tickets\/(\d+)$/,
      ({ params }) => {
        const ticket = store.ticket(id(params))
        if (!ticket) throw new HttpError(404, '没有这个 ticket')
        return { body: { ...ticket, prompt: store.ticketPrompt(ticket.id) } }
      },
    ],
    [
      'GET',
      /^\/tickets\/(\d+)\/events$/,
      ({ params, query }) => ({
        body: store.eventsOf(id(params), count(query, 'limit', 50)),
      }),
    ],
    ['GET', /^\/activity$/, () => ({ body: daemon.activity() })],
    [
      'GET',
      /^\/tickets\/(\d+)\/transcript$/,
      ({ params, query }) => {
        const rows = daemon.transcript(id(params), count(query, 'tail', 20))
        if (!rows) throw new HttpError(404, '还找不到这个 Worker 的会话记录')
        return { body: rows }
      },
    ],
    [
      'POST',
      /^\/tickets\/(\d+)\/report$/,
      ({ params, body }) => applied(daemon.report(id(params), str(body, 'summary'))),
    ],
    [
      'POST',
      /^\/tickets\/(\d+)\/ask$/,
      ({ params, body }) => {
        const options = Array.isArray(body.options)
          ? body.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '')
          : null
        const grantKey = typeof body.grantKey === 'string' ? body.grantKey : null
        const asked = daemon.ask(
          id(params),
          str(body, 'question'),
          options && options.length > 0 ? options : null,
          body.kind === 'permission' ? { grantKey } : undefined,
        )
        return asked.ok
          ? { status: 201, body: { ok: true, questionId: asked.questionId, ticket: asked.ticket } }
          : applied(asked)
      },
    ],
    [
      'POST',
      /^\/tickets\/(\d+)\/grants\/take$/,
      ({ params, body }) => ({ body: { granted: daemon.takeGrant(id(params), str(body, 'key')) } }),
    ],
    [
      'GET',
      /^\/questions\/(\d+)$/,
      async ({ params, query }) => ({
        body: await daemon.waitAnswer(id(params), waitMs(query)),
      }),
    ],
    [
      'POST',
      /^\/tickets\/(\d+)\/done$/,
      async ({ params, body }) => {
        const outcome = str(body, 'outcome') as Outcome
        if (!OUTCOMES.includes(outcome))
          throw new HttpError(400, `outcome 只能是 ${OUTCOMES.join(' / ')}`)
        return applied(await daemon.done(id(params), outcome, str(body, 'summary')))
      },
    ],
    [
      'POST',
      /^\/tickets\/(\d+)\/answer$/,
      ({ params, body }) => {
        const result = daemon.answer(id(params), str(body, 'answer'))
        return result.ok
          ? { body: { ok: true, ...result.result } }
          : { status: 409, body: { ok: false, reason: result.reason } }
      },
    ],
    [
      'POST',
      /^\/tickets\/(\d+)\/message$/,
      ({ params, body }) => {
        const actor = body.actor === 'you' ? 'you' : 'router'
        return applied(daemon.message(id(params), str(body, 'text'), actor))
      },
    ],
    [
      'POST',
      /^\/tickets\/(\d+)\/say$/,
      async ({ params, body }) => applied(await daemon.say(id(params), str(body, 'text'))),
    ],
    [
      'POST',
      /^\/tickets\/(\d+)\/close$/,
      async ({ params, body }) => applied(await daemon.close(id(params), body.discard === true)),
    ],
    ['POST', /^\/tickets\/(\d+)\/open_mr$/, ({ params }) => applied(daemon.openMr(id(params)))],
    [
      'POST',
      /^\/tickets\/(\d+)\/open_mr\/undo$/,
      ({ params }) => applied(daemon.undoOpenMr(id(params))),
    ],
    [
      'POST',
      /^\/tickets\/(\d+)\/stop$/,
      async ({ params }) => applied(await daemon.stop(id(params))),
    ],
    [
      'POST',
      /^\/tickets\/(\d+)\/retry$/,
      async ({ params }) => applied(await daemon.retry(id(params))),
    ],
    [
      'POST',
      /^\/tickets\/(\d+)\/resume$/,
      async ({ params }) => applied(await daemon.resume(id(params))),
    ],
    [
      'GET',
      /^\/events$/,
      async ({ query }) => ({
        body: await daemon.eventsSince(Number(query.get('since') ?? 0), waitMs(query)),
      }),
    ],
  ]
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new HttpError(413, '请求体过大'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {})
      } catch {
        reject(new HttpError(400, '请求体不是 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export function createHttpServer(daemon: Daemon, shutdown?: () => void): Server {
  const table = routes(daemon, shutdown)
  return createServer((req, res) => {
    daemon.lastActivity = Date.now()
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    void (async () => {
      try {
        for (const [method, pattern, handler] of table) {
          const match = pattern.exec(url.pathname)
          if (!match || method !== req.method) continue
          const body = req.method === 'POST' ? await readBody(req) : {}
          const reply = await handler({ params: match.slice(1), query: url.searchParams, body })
          return send(res, reply.status ?? 200, reply.body)
        }
        send(res, 404, { ok: false, reason: `没有 ${req.method} ${url.pathname}` })
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        send(res, status, {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  })
}
