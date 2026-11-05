import type { IncomingMessage, ServerResponse } from 'node:http'

import { NEEDS_ME } from '../core/state.js'
import type { Ticket } from '../core/types.js'
import type { Result, SuperAgentService } from './service.js'

export const API = '/superagent/api'

/** A ticket as the board draws it. */
export type TicketView = Ticket & { needsMe: boolean; activity?: { lines: string[]; at: number } }
export type StateView = { routerSessionId?: string; tickets: TicketView[]; now: number }

type Route = {
  kind: 'exact' | 'prefix'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): unknown
}

/**
 * Decides whether a request may read or drive the board. dsh's web server has
 * no server-wide authentication: each route owner enforces its own. These
 * routes use the Host's own admission (`ctx.connection.admit`): the loopback
 * Host/Origin fence plus the signed browser cookie the desktop page carries.
 */
export type Admit = (req: IncomingMessage) => { peer: unknown } | { rejection: number }

function refused(admit: Admit, req: IncomingMessage, res: ServerResponse): boolean {
  let admission: ReturnType<Admit>
  try {
    admission = admit(req)
  } catch {
    admission = { rejection: 401 }
  }
  if (!('rejection' in admission)) return false
  send(res, admission.rejection, {
    error: admission.rejection === 401 ? 'unauthorized' : 'forbidden',
  })
  return true
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 64 * 1024) throw new Error('请求太大')
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
}

export function stateView(
  service: SuperAgentService,
  routerSessionId: string | undefined,
  now: number,
): StateView {
  const tickets = service.list('live').map(t => {
    const view: TicketView = { ...t, needsMe: NEEDS_ME.includes(t.state) }
    const activity = t.sessionId === undefined ? undefined : service.activityOf(t.sessionId)
    if (activity !== undefined && t.state === 'working') view.activity = activity
    return view
  })
  return routerSessionId === undefined ? { tickets, now } : { routerSessionId, tickets, now }
}

const ACTIONS = ['stop', 'close', 'retry', 'resume', 'discard', 'open_mr'] as const
type Action = (typeof ACTIONS)[number]

export function routes(
  service: SuperAgentService,
  routerId: () => string | undefined,
  ensureRouter: () => Promise<string>,
  admit: Admit,
): Route[] {
  return [
    {
      kind: 'exact',
      path: `${API}/state`,
      handler(req, res) {
        if (refused(admit, req, res)) return
        send(res, 200, stateView(service, routerId(), Date.now()))
      },
    },
    {
      kind: 'exact',
      path: `${API}/router`,
      async handler(req, res) {
        if (refused(admit, req, res)) return
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
        try {
          send(res, 200, { sessionId: await ensureRouter() })
        } catch (error) {
          send(res, 500, { error: String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/action`,
      async handler(req, res) {
        if (refused(admit, req, res)) return
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
        let result: Result
        try {
          const body = await readJson(req)
          const action = body.action as Action
          const id = body.id
          if (!ACTIONS.includes(action) || !Number.isInteger(id)) {
            return send(res, 400, { ok: false, text: '参数不对' })
          }
          result = await (action === 'open_mr'
            ? service.openMr(id as number)
            : service[action](id as number))
        } catch (error) {
          result = { ok: false, text: String(error) }
        }
        send(res, result.ok ? 200 : 409, result)
      },
    },
  ]
}
