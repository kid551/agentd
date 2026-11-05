import { phaseWord } from '../core/state.js'
import type { StateView, TicketView } from '../host/http.js'
import { CSS } from './style.js'
import {
  ACTION_WORDS,
  actionsOf,
  ago,
  bandOf,
  bandText,
  groups,
  nextNeeding,
  stateWord,
  tone,
} from './view.js'

// The browser half: a dsh.client bundle. The build wraps this module in
// `window.__ModuleLoader__.load({ id, factory: require => … })`, so `require`
// is the loader's — React and the primitives come from the page, never bundled.

declare const require: (id: string) => unknown

type Node = unknown
type ReactLike = {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): Node
  useSyncExternalStore<T>(subscribe: (cb: () => void) => () => void, get: () => T): T
  useState<T>(init: T | (() => T)): [T, (v: T) => void]
  useEffect(run: () => void | (() => void), deps?: unknown[]): void
}

const React = require('react') as ReactLike
const primitives = require('@deepseek-ai/dsh-client-ui-primitives') as Record<string, unknown>
const h = React.createElement

const API = '/superagent/api'
const PANEL_ID = 'superagent'

// ── A polled store of the Host's ticket state ───────────────────────────────

let state: StateView | undefined
let error: string | undefined
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

async function refresh(): Promise<void> {
  try {
    const res = await fetch(`${API}/state`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    state = (await res.json()) as StateView
    error = undefined
  } catch (e) {
    error = `Super-agent 不在线：${String(e)}`
  }
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  if (timer === undefined) {
    void refresh()
    timer = setInterval(() => void refresh(), 2000)
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

const useBoard = (): { state: StateView | undefined; error: string | undefined } => {
  const s = React.useSyncExternalStore(subscribe, () => state)
  const e = React.useSyncExternalStore(subscribe, () => error)
  return { state: s, error: e }
}

async function act(action: string, id: number): Promise<string> {
  const res = await fetch(`${API}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, id }),
  })
  const body = (await res.json()) as { text?: string }
  void refresh()
  return body.text ?? (res.ok ? '好了' : '失败')
}

async function routerId(): Promise<string> {
  const known = state?.routerSessionId
  if (known !== undefined) return known
  const res = await fetch(`${API}/router`, { method: 'POST' })
  const body = (await res.json()) as { sessionId: string }
  return body.sessionId
}

// ── Components ──────────────────────────────────────────────────────────────

type Nav = { open(sessionId: string): void }

function BoardIcon({ size }: { size?: number }): Node {
  const Icon = primitives.IconAgentPresetOutlineRegular ?? primitives.IconQueueOutlineRegular
  return Icon === undefined ? h('span', { className: 'sa-glyph' }, '奏') : h(Icon, { size })
}

function Card({
  t,
  now,
  nav,
  say,
}: {
  t: TicketView
  now: number
  nav: Nav
  say(text: string): void
}): Node {
  const body = t.pending
    ? `等你：${t.pending.summary}`
    : t.activity !== undefined
      ? t.activity.lines.join('\n')
      : (t.lastReport ?? t.task)
  const stale = t.activity !== undefined && now - t.activity.at > 5 * 60_000
  // Giving an MR ticket up deletes its worktree and branch: a second press confirms.
  const [isConfirming, setConfirming] = React.useState(false)
  return h(
    'article',
    {
      className: `sa-card sa-${tone(t.state)}${t.state === 'done' || t.state === 'stopped' ? ' sa-ended' : ''}`,
    },
    h(
      'header',
      { className: 'sa-card-head' },
      h('span', { className: 'sa-dot', 'aria-hidden': true }),
      h('span', { className: 'sa-id' }, `#${t.id}`),
      h('span', { className: 'sa-project' }, t.project),
      h('span', { className: 'sa-title' }, t.title),
      h('span', { className: 'sa-state' }, phaseWord(t)),
      t.readonly === true ? h('span', { className: 'sa-tag' }, '只读') : null,
      t.branch !== undefined ? h('span', { className: 'sa-tag' }, `⎇ ${t.branch}`) : null,
    ),
    h('p', { className: 'sa-body' }, body),
    t.activity !== undefined
      ? h(
          'p',
          { className: `sa-meta${stale ? ' sa-stale' : ''}` },
          `最近动作 ${ago(now - t.activity.at)}`,
        )
      : null,
    h(
      'footer',
      { className: 'sa-actions' },
      ...actionsOf(t).map(a =>
        h(
          'button',
          {
            key: a,
            type: 'button',
            className: 'sa-button',
            onClick: () => {
              if (a === 'chat' && t.sessionId !== undefined) nav.open(t.sessionId)
              else if (a === 'discard' && !isConfirming) setConfirming(true)
              else {
                setConfirming(false)
                void act(a, t.id).then(say, e => say(String(e)))
              }
            },
          },
          a === 'discard' && isConfirming ? '确认放弃？会删掉 worktree 和分支' : ACTION_WORDS[a],
        ),
      ),
    ),
  )
}

function BoardPage({ nav }: { nav: Nav }): Node {
  const { state: s, error: e } = useBoard()
  const [toast, setToast] = React.useState<string | undefined>(undefined)
  const now = s?.now ?? Date.now()
  const say = (text: string): void => {
    setToast(text)
    setTimeout(() => setToast(undefined), 4000)
  }
  const next = s === undefined ? undefined : nextNeeding(s.tickets, undefined)
  return h(
    'section',
    { className: 'sa-page' },
    h(
      'div',
      { className: 'sa-toolbar' },
      h('h1', { className: 'sa-heading' }, 'Super-agent 奏折'),
      h(
        'button',
        {
          type: 'button',
          className: 'sa-button',
          onClick: () =>
            void routerId().then(
              id => nav.open(id),
              err => say(String(err)),
            ),
        },
        '打开 Router',
      ),
      next !== undefined
        ? h(
            'button',
            {
              type: 'button',
              className: 'sa-button',
              onClick: () => next.sessionId && nav.open(next.sessionId),
            },
            `下一张待处理：#${next.id}`,
          )
        : null,
    ),
    e !== undefined ? h('p', { className: 'sa-alert' }, e) : null,
    toast !== undefined ? h('p', { className: 'sa-toast', role: 'status' }, toast) : null,
    s !== undefined && s.tickets.length === 0
      ? h('p', { className: 'sa-empty' }, '还没有奏折。打开 Router，告诉它要做什么。')
      : null,
    ...(s === undefined ? [] : groups(s.tickets)).map(g =>
      h(
        'div',
        { key: g.key, className: 'sa-group' },
        h('h2', { className: 'sa-group-title' }, `${g.title} · ${g.tickets.length}`),
        ...g.tickets.map(t => h(Card, { key: t.id, t, now, nav, say })),
      ),
    ),
  )
}

/** Status dot on a Worker's sidebar row. */
function RowBadge({ sessionId }: { sessionId: string }): Node {
  const { state: s } = useBoard()
  const t = s?.tickets.find(x => x.sessionId === sessionId)
  if (t === undefined) return null
  return h(
    'span',
    { className: `sa-badge sa-${tone(t.state)}`, title: `#${t.id} ${stateWord(t.state)}` },
    `#${t.id}`,
  )
}

function RowHover({ sessionId }: { sessionId: string }): Node {
  const { state: s } = useBoard()
  const t = s?.tickets.find(x => x.sessionId === sessionId)
  if (t === undefined) return null
  const lines = t.activity?.lines ?? (t.lastReport ? [t.lastReport] : [])
  return h(
    'div',
    { className: 'sa-hover' },
    h('div', null, `#${t.id} · ${stateWord(t.state)}`),
    ...lines.map((l, i) => h('div', { key: i, className: 'sa-hover-line' }, l)),
  )
}

/** The band above the composer: who the person is talking to. */
function Band({ bandSessionId, nav }: { bandSessionId?: string; nav: Nav }): Node {
  const { state: s } = useBoard()
  const view = bandOf(s, bandSessionId)
  if (view.kind === 'none') return null
  const toneClass =
    view.kind === 'router'
      ? view.needs > 0
        ? 'sa-warn'
        : 'sa-success'
      : `sa-${tone(view.ticket.state)}`
  return h(
    'div',
    { className: `sa-band ${toneClass}` },
    h('span', { className: 'sa-band-text' }, bandText(view)),
    view.kind === 'worker' && s?.routerSessionId !== undefined
      ? h(
          'button',
          {
            type: 'button',
            className: 'sa-button',
            onClick: () => nav.open(s.routerSessionId as string),
          },
          '返回 Router',
        )
      : null,
    view.kind === 'router' && view.needs > 0 && s !== undefined
      ? h(
          'button',
          {
            type: 'button',
            className: 'sa-button',
            onClick: () => {
              const next = nextNeeding(s.tickets, undefined)
              if (next?.sessionId !== undefined) nav.open(next.sessionId)
            },
          },
          '下一张',
        )
      : null,
  )
}

// ── Registration ────────────────────────────────────────────────────────────

type Slots = {
  inject(name: string, register: () => unknown): void
  register(spec: Record<string, unknown>, component: unknown): unknown
}
type ClientContext = {
  slots: Slots
  uiWorkspace: { openSession(target: string): void }
  effect(run: () => (() => void) | void, label?: string): void
}

export const name = 'superagent-client'
export const inject = ['slots', 'uiWorkspace']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    if (
      typeof document === 'undefined' ||
      document.querySelector('style[data-plugin-css="superagent"]') !== null
    )
      return
    const style = document.createElement('style')
    style.setAttribute('data-plugin-css', 'superagent')
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'superagent: styles')

  const nav: Nav = { open: id => ctx.uiWorkspace.openSession(id) }
  const { slots } = ctx
  slots.inject('sidebar.panellist', () =>
    slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: 'Super-agent 奏折' },
      BoardIcon,
    ),
  )
  slots.inject('main', () =>
    slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ nav }) }, BoardPage),
  )
  slots.inject('sidebar.session.row.leading', () =>
    slots.register(
      { name: 'sidebar.session.row.leading', id: 'superagent-badge', order: 5 },
      RowBadge,
    ),
  )
  slots.inject('sidebar.session.row.hover', () =>
    slots.register(
      { name: 'sidebar.session.row.hover', id: 'superagent-hover', order: 5 },
      RowHover,
    ),
  )
  slots.inject('conversation.input.dock', () =>
    slots.register(
      {
        name: 'conversation.input.dock',
        id: 'superagent-band',
        order: 5,
        inject: (sessionId: string) => ({ bandSessionId: sessionId, nav }),
      },
      Band,
    ),
  )
}
