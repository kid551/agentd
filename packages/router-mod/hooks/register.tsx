import { atom, read, update } from 'claude-code'
import type { Register, RenderChildren, UiPressArgument } from 'claude-code'

import type {
  Activity,
  ActivityLite,
  Chat,
  Daemon,
  EventLite,
  TicketLite,
  Unfolded,
} from '../types'
import { Api, lite, liteEvent, type FeedEvent, type Ticket } from './api'
import {
  ago,
  bandFill,
  bandLine,
  bandView,
  card,
  chatNote,
  cardText,
  COMPACT_NOTE,
  chatMissNote,
  digest,
  endedPage,
  FOLD_ROWS,
  header,
  LINK,
  isLong,
  mentionDepth,
  nextAsking,
  nextTicket,
  overview,
  projectColor,
  ROUTER_PROMPT,
  seconds,
  stateLook,
  openMrMessage,
  phaseWord,
  ticketSections,
} from './text'

const PLUGIN = 'agentd-router'
const PANE = 'agentd-tickets'
const TOOL_PREFIX = `mcp__${PLUGIN}__`

// Session state the drawings read. Shaped values change tag when their fields change.
const tickets = atom({ plugin: 'agentd-router', key: 'tickets' } as const, [] as TicketLite[], {
  shape: 'tickets-3',
})
const queue = atom({ plugin: 'agentd-router', key: 'queue' } as const, [] as EventLite[], {
  shape: 'queue-1',
})
const activity = atom(
  { plugin: 'agentd-router', key: 'activity' } as const,
  { items: [], tick: 0 } as Activity,
  { shape: 'activity-1' },
)
const chat = atom({ plugin: 'agentd-router', key: 'chat' } as const, null as Chat | null, {
  shape: 'chat-1',
})
const daemon = atom({ plugin: 'agentd-router', key: 'daemon' } as const, 'starting' as Daemon)
const confirmStop = atom(
  { plugin: 'agentd-router', key: 'confirmStop' } as const,
  null as number | null,
)
const confirmDiscard = atom(
  { plugin: 'agentd-router', key: 'confirmDiscard' } as const,
  null as number | null,
)
const isInjectBlocked = atom({ plugin: 'agentd-router', key: 'isInjectBlocked' } as const, false)
const endedAt = atom({ plugin: 'agentd-router', key: 'endedPage' } as const, 0)
const unfolded = atom({ plugin: 'agentd-router', key: 'unfolded' } as const, {} as Unfolded, {
  shape: 'unfolded-1',
})
// 进行中 drawn as ended tickets are, two lines and the last move's age. Not
// cleared at session.start: how to look is the person's choice, not the session's.
const isWorkingBrief = atom({ plugin: 'agentd-router', key: 'isWorkingBrief' } as const, false)

/** Event kinds that need the person, and so go to the Router. */
const NOTIFY = new Set([
  'ask',
  'ready',
  'blocked',
  'failed',
  'dropped',
  'stalled',
  'exited',
  'spawn_failed',
  'merged',
  'kept',
])
/** Tools the Router may not use: it routes, Workers do the work — reading included. */
const DENIED = new Set([
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'Workflow',
  'PowerShell',
])
/** Prompt origins that are the person typing. */
const PERSON = new Set(['composer', 'sdk', 'bridge'])
/** Wait this long after the last event before handing a batch to the Router. */
const BATCH_IDLE_MS = 1500
const POLL_MS = 2000
/** A working Worker silent this long is flagged on its card. */
const QUIET_MS = 5 * 60_000
const WORKING = '进行中'
const REFRESH_MS = 10_000

const TOOLS = [
  {
    name: 'dispatch',
    description:
      '开一张 ticket，派一个 Worker 到某个项目目录里干活。project 是项目名（目录名即可，歧义时会返回候选让你问用户）；title 是不超过 30 字的中文概括；prompt 是 Worker 能独立执行的完整任务描述。MR 项目里写代码的 ticket 会自动得到自己的 worktree。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        title: { type: 'string' },
        prompt: { type: 'string' },
        readonly: {
          type: 'boolean',
          description:
            '只查看、分析、回答问题，不改任何东西时设 true：Worker 写不了文件，不占项目，可以马上并行开始',
        },
        model: { type: 'string', description: '只在用户指定时填，如 sonnet / opus' },
      },
      required: ['project', 'title', 'prompt'],
    },
  },
  {
    name: 'status',
    description: '所有未结束 ticket 的一屏总览，需要用户处理的排在前面。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read',
    description:
      '读某张 ticket 的细节（链式召回）。what=summary：任务原文、状态、最近消息与待答问题；events：事件流全文；transcript：Worker 会话最后几条记录。',
    inputSchema: {
      type: 'object',
      properties: {
        ticket: { type: 'number' },
        what: { type: 'string', enum: ['summary', 'events', 'transcript'] },
        limit: { type: 'number' },
      },
      required: ['ticket'],
    },
  },
  {
    name: 'answer',
    description:
      '把用户对某 ticket 待答问题的回答送给它的 Worker。权限请求只回「批准」或「拒绝」。',
    inputSchema: {
      type: 'object',
      properties: { ticket: { type: 'number' }, answer: { type: 'string' } },
      required: ['ticket', 'answer'],
    },
  },
  {
    name: 'message',
    description:
      '给某 ticket 的 Worker 追加指令，或让已就绪的 Worker 继续改。ticket 有待答问题时用 answer；已收的 ticket Worker 已停，要继续就 dispatch 新 ticket。用户同意开 MR 不用它，用 open_mr。',
    inputSchema: {
      type: 'object',
      properties: { ticket: { type: 'number' }, text: { type: 'string' } },
      required: ['ticket', 'text'],
    },
  },
  {
    name: 'close',
    description:
      '用户验收通过，关闭 ticket，并停掉它的 Worker。之后不能再给它发消息。还没合入的 MR ticket 收 = 放弃改动、删掉它的 worktree 和分支：先跟用户确认，确认后带 discard=true。',
    inputSchema: {
      type: 'object',
      properties: { ticket: { type: 'number' }, discard: { type: 'boolean' } },
      required: ['ticket'],
    },
  },
  {
    name: 'open_mr',
    description:
      'MR ticket 待审（ready）时，用户审过交付、同意开 MR 后调用：Worker 接着 commit、push、开 MR、盯流水线到合入，合入后 ticket 自动结束并清理。用户同意时还交代了别的（例如先验证），写进 text 一起送到。',
    inputSchema: {
      type: 'object',
      properties: {
        ticket: { type: 'number' },
        text: { type: 'string', description: '用户同意时附带的要求，没有就不填' },
      },
      required: ['ticket'],
    },
  },
  {
    name: 'stop',
    description: '用户叫停 ticket，停止它的 Worker。只在用户明确要求停止时调用。',
    inputSchema: {
      type: 'object',
      properties: { ticket: { type: 'number' } },
      required: ['ticket'],
    },
  },
  {
    name: 'retry',
    description:
      '重试 ticket：Worker 没能启动的（例如目录未被信任，用户处理之后）重新排队；blocked / failed 且有 Worker 的，让 Worker 接着原会话重启，被权限审查拒绝的操作这次会转给用户批准。',
    inputSchema: {
      type: 'object',
      properties: { ticket: { type: 'number' } },
      required: ['ticket'],
    },
  },
  {
    name: 'resume',
    description:
      '恢复已停（stopped）的 ticket：Worker 接着原会话重启，先只读自查现场、汇报，再问用户下一步，问之前不做写操作。只用于已停的；blocked / failed 用 retry，已收的派新 ticket。',
    inputSchema: {
      type: 'object',
      properties: { ticket: { type: 'number' } },
      required: ['ticket'],
    },
  },
  {
    name: 'projects',
    description: '列出可以派工的项目，可按关键字过滤。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  },
]

const COMMANDS = [
  ['next', '单聊下一份等你处理的奏折，并把它的问题或交付再贴一次'],
  ['ticket', '和某份奏折单聊：/ticket 12'],
  ['router', '结束单聊，你的话回到 Router'],
  ['tickets', '打印奏折总览'],
  ['r', '单聊时，把这句话发给 Router 而不是 Worker：/r 你的话'],
  ['agentd', '守护进程：/agentd status | start | restart（换上新构建）'],
] as const

type Answer = { ok: boolean; questionId: number; hadWaiter: boolean; workerName: string }
type ToolAnswer = { result: string } | { deny: string }

/** What the session's hooks share; built in session.start, where its `$` is in scope. */
type Kit = {
  api: Api
  agentdHome: string
  /** `/status` asked whether the running daemon is this plugin's build. */
  statusPath: string
  refresh: () => Promise<void>
  poll: () => Promise<void>
  flush: () => Promise<void>
  startDaemon: () => Promise<boolean>
  ticketById: (id: number) => Promise<TicketLite | undefined>
  endChat: (id: number) => Promise<void>
  takeEvents: () => Promise<EventLite[]>
  deliverAnswer: (t: TicketLite, text: string) => Promise<string | null>
  deliverMessage: (t: TicketLite, text: string, isPerson?: boolean) => Promise<string | null>
  runTool: (tool: string, input: Record<string, unknown>) => Promise<ToolAnswer>
  open: (t: TicketLite) => Promise<void>
}

const ok = (text: string): ToolAnswer => ({ result: text })
const fail = (text: string): ToolAnswer => ({ deny: text })

export const register: Register = on => {
  // Module values start over on every reload; session.start sets them again.
  let kit: Kit | null = null
  let isRouterBusy = false
  let isSnapshotSent = false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const cwd = await $.session.cwd()
    const isRouter =
      (await $.env.get('AGENTD_ROUTER')) === '1' || (await $.fs.exists(`${cwd}/.agentd-router`))
    if (!isRouter) return started
    // Unfolded cards are the view of the moment: a reload shows them folded again.
    await update($, unfolded, () => ({}))

    const port = (await $.env.get('AGENTD_PORT')) ?? '7707'
    const agentdHome =
      (await $.env.get('AGENTD_HOME')) ?? `${(await $.env.get('HOME')) ?? '~'}/.agentd`
    const daemonScript = `${$.plugin.root}/daemon/agentd.mjs`
    const statusPath = `/status?script=${encodeURIComponent(daemonScript)}`
    const api = new Api((url, init) => $.http.fetch(url, init), `http://127.0.0.1:${port}`)
    let cursor = 0
    let lastEventAt = 0
    let lastRefresh = 0
    let isPolling = false

    /**
     * Ends the chat with a ticket, for any reason but the person leaving it
     * (`/router`, the Pane button). It passes to the question waiting longest,
     * so the person answers them one after another; with none, the words go
     * back to the Router.
     */
    const endChat = async (id: number): Promise<void> => {
      const current = await read($, chat)
      if (current?.ticket !== id) return
      const following = nextAsking(await read($, tickets), id)
      await update($, chat, () => (following ? { ticket: following.id, isAuto: true } : null))
    }

    const refresh = async (): Promise<void> => {
      const r = await api.get<Ticket[]>('/tickets?state=recent')
      if (!r.ok) return
      lastRefresh = await $.clock.now()
      await update($, tickets, () => r.data.map(lite))
      // A chat with a ticket that ended (dropped, exited, closed from the Pane)
      // ends too; one its question opened ends once that question is gone
      // (answered through the Router or the Pane, withdrawn).
      const current = await read($, chat)
      if (current === null) return
      const t = r.data.find(x => x.id === current.ticket)
      if (
        !t ||
        t.state === 'done' ||
        t.state === 'stopped' ||
        (current.isAuto && !t.openQuestion)
      ) {
        await endChat(current.ticket)
      }
    }

    const ticketById = async (id: number): Promise<TicketLite | undefined> =>
      (await read($, tickets)).find(t => t.id === id)

    const startDaemon = async (): Promise<boolean> => {
      if ((await api.get('/status')).ok) return true
      if (!(await $.fs.exists(daemonScript))) {
        $.ui.toast(`找不到 ${daemonScript}，先在 agentd 仓库运行 pnpm build`)
        return false
      }
      await update($, daemon, () => 'starting' as Daemon)
      // The daemon outlives this session so Workers can still report; it
      // detaches itself and exits after 30 idle minutes with no live ticket.
      const launched = await $.process.run(
        ['node', daemonScript, 'serve', '--detach', '--port', port, '--idle-exit', '1800'],
        { env: { AGENTD_HOME: agentdHome }, timeoutMs: 15_000 },
      )
      if (launched.exitCode !== 0) {
        $.ui.toast(`agentd 没能启动：${launched.stderr.slice(0, 200)}`)
        return false
      }
      for (let i = 0; i < 20; i++) {
        await $.clock.sleep(300)
        if ((await api.get('/status')).ok) return true
      }
      return false
    }

    /**
     * Takes the waiting events the Router may hear now. While the person answers
     * one question, every other ticket's events wait their turn: each needs the
     * person's word (an answer, a 收了), and told of one now, the person would
     * give it, and the words would go to the chat's Worker.
     */
    const takeEvents = async (): Promise<EventLite[]> => {
      const current = await read($, chat)
      const answering =
        current && (await ticketById(current.ticket))?.question ? current.ticket : null
      const taken = (await read($, queue)).filter(
        ev => answering === null || ev.ticketId === answering,
      )
      if (taken.length > 0) {
        const ids = new Set(taken.map(ev => ev.id))
        await update($, queue, list => list.filter(ev => !ids.has(ev.id)))
      }
      return taken
    }

    /** Hands the waiting events to the Router as one prompt, once it is idle and the feed quiet. */
    const flush = async (): Promise<void> => {
      if (isRouterBusy || (await read($, isInjectBlocked))) return
      if ((await read($, queue)).length === 0) return
      if ((await $.clock.now()) - lastEventAt < BATCH_IDLE_MS) return
      const waiting = await takeEvents()
      if (waiting.length === 0) return
      const restore = async (): Promise<void> => {
        await update($, queue, list => [...waiting, ...list].sort((a, b) => a.id - b.id))
        await update($, isInjectBlocked, () => true)
      }
      try {
        const r = await $.prompt.submit({ text: digest(waiting) })
        if (r.drop !== undefined) await restore()
      } catch {
        // Refused until the person sends something (after an Esc, or before the
        // first prompt): the events ride along with their next message instead.
        await restore()
      }
    }

    // A working Worker's last lines, read each poll so the card shows it is alive.
    // The tick moves every 10 s even when nothing new is written, so the age the
    // card shows keeps counting instead of freezing at its last value.
    const follow = async (): Promise<void> => {
      const isWorking = (await read($, tickets)).some(t => t.state === 'working')
      const r = isWorking ? await api.get<ActivityLite[]>('/activity') : null
      if (r && !r.ok) return
      const latest: Activity = {
        items: r?.data ?? [],
        tick: isWorking ? Math.floor((await $.clock.now()) / 10_000) : 0,
      }
      if (JSON.stringify(latest) !== JSON.stringify(await read($, activity))) {
        await update($, activity, () => latest)
      }
    }

    const poll = async (): Promise<void> => {
      if (isPolling) return
      isPolling = true
      try {
        const r = await api.get<FeedEvent[]>(`/events?since=${cursor}`)
        if (!r.ok) {
          if ((await read($, daemon)) !== 'down') await update($, daemon, () => 'down' as Daemon)
          return
        }
        if ((await read($, daemon)) !== 'up') await update($, daemon, () => 'up' as Daemon)
        if (r.data.length > 0) {
          cursor = (r.data.at(-1) as FeedEvent).id
          const notify = r.data.filter(ev => NOTIFY.has(ev.kind)).map(liteEvent)
          if (notify.length > 0) {
            lastEventAt = await $.clock.now()
            await update($, queue, list => [...list, ...notify])
          }
          await refresh()
          // A chat ends once its Worker hands its work in: what the person says
          // next (a 收了) is for the Router. Blocked or failed it stays, since the
          // person answers those in the chat; a question still open keeps it too.
          const current = await read($, chat)
          const t = await ticketById(current?.ticket ?? -1)
          if (
            t?.state === 'ready' &&
            !t.question &&
            notify.some(ev => ev.ticketId === t.id && ev.kind === 'ready')
          ) {
            await endChat(t.id)
          }
          // A question opens a chat when there is none; a chat is never stolen.
          const asked = notify.find(ev => ev.kind === 'ask')
          if (asked && (await read($, chat)) === null) {
            await update($, chat, () => ({ ticket: asked.ticketId, isAuto: true }))
          }
        } else if ((await $.clock.now()) - lastRefresh > REFRESH_MS) {
          await refresh()
        }
        await follow()
        await flush()
      } finally {
        isPolling = false
      }
    }

    /**
     * Answers a ticket's question. A permission hook fetches its answer from the
     * daemon; an `ask` returned at once, so its Worker hears the answer as a
     * message (`hadWaiter` is true only for a Worker started before asks
     * stopped waiting, which gets it as the tool's result instead).
     */
    const deliverAnswer = async (t: TicketLite, text: string): Promise<string | null> => {
      const r = await api.post<Answer>(`/tickets/${t.id}/answer`, { answer: text })
      if (!r.ok) return r.reason
      let problem: string | null = null
      if (!r.data.hadWaiter) {
        const sent = await $.session.send({
          to: r.data.workerName,
          text: `【agentd ticket #${t.id} 回答】你问的「${t.question ?? ''}」，用户的回答：${text}`,
        })
        if (!sent.isDelivered) {
          problem = `回答已记下，但没送到 ${header(t)} 的 Worker：${sent.reason}。它多半已退出，可以「打开」看看或重试。`
        }
      }
      await refresh()
      return problem
    }

    /**
     * Hands the Worker more to do; the ticket moves only once the Worker has the words.
     * `isPerson`: typed by the person in a chat, never the Router's paraphrase.
     */
    const deliverMessage = async (
      t: TicketLite,
      text: string,
      isPerson = false,
    ): Promise<string | null> => {
      if (!t.workerBgId) return `${header(t)} 的 Worker 没有启动过，用 retry。`
      if (t.state === 'stopped')
        return `${header(t)} 已停，Worker 不在了。要接着做请先恢复（resume）。`
      if (isPerson && t.workerSessionId && (t.state === 'blocked' || t.state === 'failed')) {
        // A stopped Worker hears the person in its own session, as a user turn:
        // its permission review counts that as approval, a peer message it does not.
        const r = await api.post(`/tickets/${t.id}/say`, { text })
        await refresh()
        return r.ok ? null : r.reason
      }
      // Deliver first: a message the Worker never got must not move the ticket.
      // (A closed or stopped ticket's Worker is gone, so the send fails here.)
      const sent = await $.session.send({
        to: t.workerName,
        text: `【agentd ticket #${t.id} 追加指令】${text}`,
      })
      if (!sent.isDelivered) return `没送到 Worker：${sent.reason}`
      const r = await api.post(`/tickets/${t.id}/message`, { text })
      await refresh()
      return r.ok ? null : r.reason
    }

    const open = async (t: TicketLite): Promise<void> => {
      // A live Worker is attached to, never resumed: `claude --resume` on a
      // running session starts a second process on the same conversation.
      if (t.workerBgId && t.state !== 'done' && t.state !== 'stopped' && t.state !== 'queued') {
        // iTerm2 takes no command-line command, so it is driven by AppleScript.
        const r = await $.process.run([
          'osascript',
          '-e',
          'tell application "iTerm"',
          '-e',
          `create window with default profile command "/bin/zsh -lic 'claude attach ${t.workerBgId}'"`,
          '-e',
          'activate',
          '-e',
          'end tell',
        ])
        $.ui.toast(
          r.exitCode === 0
            ? `已在 iTerm2 挂上 ${header(t)} 的 Worker · ← 返回列表，关窗口不影响它`
            : `打不开 iTerm2：${r.stderr.trim() || `退出码 ${r.exitCode}`}`,
        )
        return
      }
      if (!t.workerSessionId) {
        $.ui.toast(`${header(t)} 的 Worker 会话还没就绪`)
        return
      }
      // An ended Worker's conversation opens in VS Code to read. A deeplink
      // resolves only in the window of the session's own folder, so bring that
      // window up first (implementation-notes S1).
      await $.process.run(['open', '-a', 'Visual Studio Code', t.cwd])
      await $.clock.sleep(1500)
      await $.process.run([
        'open',
        `vscode://anthropic.claude-code/open?session=${t.workerSessionId}`,
      ])
    }

    const runTool = async (tool: string, input: Record<string, unknown>): Promise<ToolAnswer> => {
      if (tool === 'dispatch') {
        const r = await api.post<{ ok: boolean; ticket: Ticket; note?: string }>('/tickets', {
          project: input.project,
          title: input.title,
          prompt: input.prompt,
          readonly: input.readonly === true,
          ...(typeof input.model === 'string' && input.model ? { model: input.model } : {}),
        })
        if (!r.ok) return fail(r.reason)
        await refresh()
        const how = r.data.ticket.readonly
          ? '，只读'
          : r.data.ticket.worktree
            ? '，MR 奏折：在自己的 worktree 里做'
            : ''
        const note = r.data.note ? `${r.data.note}。` : ''
        return ok(`${header(r.data.ticket)} 已派出（${r.data.ticket.cwd}${how}）。${note}`)
      }
      if (tool === 'status') {
        await refresh()
        return ok(overview(await read($, tickets)))
      }
      if (tool === 'projects') {
        const r = await api.get<{ id: string; path: string }[]>('/projects')
        if (!r.ok) return fail(r.reason)
        const q = typeof input.query === 'string' ? input.query.toLowerCase() : ''
        const hits = r.data.filter(p => !q || p.id.toLowerCase().includes(q)).slice(0, 40)
        return ok(hits.map(p => `${p.id}  ${p.path}`).join('\n') || '没有匹配的项目。')
      }

      const id = Number(input.ticket)
      if (!Number.isInteger(id) || id <= 0) return fail('需要 ticket 号')

      if (tool === 'read') {
        const what = typeof input.what === 'string' ? input.what : 'summary'
        const limit = Number(input.limit ?? 20)
        if (what === 'events') {
          const r = await api.get<{ kind: string; actor: string; body: { text?: string } }[]>(
            `/tickets/${id}/events?limit=${limit}`,
          )
          return r.ok
            ? ok(r.data.map(ev => `${ev.kind}（${ev.actor}）：${ev.body.text ?? ''}`).join('\n'))
            : fail(r.reason)
        }
        if (what === 'transcript') {
          const r = await api.get<{ role: string; text: string; tools: string[] }[]>(
            `/tickets/${id}/transcript?tail=${limit}`,
          )
          return r.ok
            ? ok(
                r.data
                  .map(
                    row =>
                      `${row.role}${row.tools.length ? ` [${row.tools.join(', ')}]` : ''}：${row.text}`,
                  )
                  .join('\n'),
              )
            : fail(r.reason)
        }
        const r = await api.get<Ticket & { prompt: string }>(`/tickets/${id}`)
        if (!r.ok) return fail(r.reason)
        const t = r.data
        const question = t.openQuestion
          ? `待答问题：${t.openQuestion.question}${t.openQuestion.options ? `（选项：${t.openQuestion.options.join(' / ')}）` : ''}`
          : ''
        return ok(
          [
            `${header(t)}（${phaseWord(t)}${t.readonly ? '，只读' : ''}）目录：${t.cwd}${t.branch ? `，分支 ${t.branch}` : ''}`,
            `任务：${t.prompt}`,
            // The open question is the latest message while it waits: say it once.
            t.lastReport && t.lastReport !== t.openQuestion?.question
              ? `最近消息：${t.lastReport}${t.lastAnswer ? `\n你答：${t.lastAnswer}` : ''}`
              : '',
            question,
            '更多：read 的 what=events 看事件流，what=transcript 看 Worker 会话。',
          ]
            .filter(Boolean)
            .join('\n'),
        )
      }

      let t = await ticketById(id)
      if (!t) {
        await refresh()
        t = await ticketById(id)
      }
      if (!t) return fail(`没有 ticket #${id}`)

      if (tool === 'answer') {
        const problem = await deliverAnswer(t, String(input.answer ?? ''))
        return problem === null ? ok(`已送达 ${header(t)}，Worker 继续。`) : fail(problem)
      }
      if (tool === 'message') {
        // A Worker that asked goes on meanwhile, so it can take more words; one
        // held in a permission hook cannot read them until it is answered.
        if (t.isPermission) return fail(`${header(t)} 在等权限审批「${t.question}」，请用 answer。`)
        const problem = await deliverMessage(t, String(input.text ?? ''))
        return problem === null ? ok(`已转给 ${header(t)}。`) : fail(problem)
      }
      if (tool === 'open_mr') {
        if (!t.worktree || !t.branch) return fail(`${header(t)} 不是 MR 奏折，没有 MR 可开。`)
        if (t.state !== 'ready')
          return fail(`${header(t)} 处于「${phaseWord(t)}」，只有待审的能开 MR。`)
        // Record first, unlike a message: the Worker checks the record (mr_consent)
        // before it commits, so the yes must be there when the words arrive.
        const r = await api.post(`/tickets/${t.id}/open_mr`)
        if (!r.ok) {
          await refresh()
          return fail(r.reason)
        }
        const note = typeof input.text === 'string' ? input.text : ''
        const sent = await $.session.send({
          to: t.workerName,
          text: openMrMessage(t.id, t.branch, note),
        })
        if (!sent.isDelivered) {
          const undone = await api.post(`/tickets/${t.id}/open_mr/undo`)
          await refresh()
          return fail(
            `没送到 ${header(t)} 的 Worker：${sent.reason}。` +
              (undone.ok ? '开 MR 已撤回，奏折仍待审。' : `开 MR 已记下但撤不回：${undone.reason}`),
          )
        }
        await refresh()
        return ok(
          `${header(t)} 开 MR 了：Worker 会 commit、push、开 MR、盯到合入，合入后自动结束并清理。`,
        )
      }
      if (tool === 'close' || tool === 'stop' || tool === 'retry' || tool === 'resume') {
        const r = await api.post<{ ticket: Ticket }>(
          `/tickets/${t.id}/${tool}`,
          tool === 'close' ? { discard: input.discard === true } : {},
        )
        if (!r.ok) return fail(r.reason)
        await refresh()
        if (tool === 'close' || tool === 'stop') await endChat(t.id)
        const word = {
          close: input.discard === true ? '已放弃，worktree 和分支已清理' : '已关闭',
          stop: '已叫停',
          // A Worker that handed back is relaunched on its conversation, not queued.
          retry: t.workerBgId ? '的 Worker 已接着原会话重启' : '已重新排队',
          resume: '的 Worker 已接着原会话恢复，会先自查现场、汇报，再问你下一步',
        }[tool]
        return ok(`${header(t)} ${word}。`)
      }
      return fail(`没有工具 ${tool}`)
    }

    kit = {
      api,
      agentdHome,
      statusPath,
      refresh,
      poll,
      flush,
      startDaemon,
      ticketById,
      endChat,
      takeEvents,
      deliverAnswer,
      deliverMessage,
      runTool,
      open,
    }

    // Registering and reaching the daemon need nothing of each other: all at once.
    const [up] = await Promise.all([
      startDaemon(),
      Promise.all(TOOLS.map(spec => $.tool.register({ ...spec, isDeferred: false }))),
      Promise.all(
        COMMANDS.map(([name, description]) =>
          // One refused name (a built-in took it) must not cost the others.
          $.command.register({ name, description }).catch((error: unknown) => {
            $.ui.toast(`agentd-router：/${name} 没能注册（${String(error).slice(0, 80)}）`)
          }),
        ),
      ),
    ])
    await update($, daemon, () => (up ? 'up' : 'down') as Daemon)
    if (up) {
      const [status] = await Promise.all([
        api.get<{ lastEventId: number; isStale?: boolean }>(statusPath),
        refresh(),
      ])
      if (status.ok) {
        cursor = status.data.lastEventId
        if (status.data.isStale) $.ui.toast('agentd 守护进程跑的是旧构建：/agentd restart 换新')
      }
    }
    $.clock.every(POLL_MS, () => void kit?.poll())
    void $.ui.open({ id: PANE, title: 'agentd 奏折' })
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!kit) return composed
    return {
      sections: [
        ...composed.sections,
        { id: `${PLUGIN}:role`, text: ROUTER_PROMPT, scope: 'session' as const },
      ],
    }
  })

  on('session.compact', async ($, e, next) => {
    if (!kit || e.agentId !== undefined) return next(e)
    const done = await next({
      ...e,
      instructions: [e.instructions, COMPACT_NOTE].filter(Boolean).join('\n'),
    })
    // The summary may drop or misstate tickets: the next words carry a fresh overview.
    if (done.skip === undefined) isSnapshotSent = false
    return done
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) isRouterBusy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      isRouterBusy = false
      void kit?.flush()
    }
    return done
  })

  on('prompt.submit', async ($, e, next) => {
    if (!kit || e.command || e.isMeta || !PERSON.has(e.origin?.kind ?? 'composer')) return next(e)
    await update($, isInjectBlocked, () => false)

    // In a chat the words go straight to the ticket's Worker: the answer to its
    // question, or else more to do. The Router keeps a line of it.
    const context = [...(e.context ?? [])]
    const chatting = await read($, chat)
    const t = await kit.ticketById(chatting?.ticket ?? -1)
    if (chatting && t) {
      const problem = t.question
        ? await kit.deliverAnswer(t, e.text)
        : await kit.deliverMessage(t, e.text, true)
      if (problem === null) {
        const note = t.question
          ? `[agentd] 用户已直接回答 ${header(t)} 的问题「${t.question}」：${e.text}`
          : `[agentd] 用户直接对 ${header(t)} 的 Worker 说：${e.text}`
        await $.session.append({
          message: { type: 'user', content: [{ type: 'text', text: note }] },
        })
        // A chat its question opened ends with the answer, and the next question
        // waiting takes it; one the person opened stays.
        if (t.question && chatting.isAuto) await kit.endChat(t.id)
        $.ui.toast(`已送达 ${header(t)}`)
        return { drop: `已直接发给 ${header(t)} 的 Worker` }
      }
      // The Worker never got the words: the Router handles them.
      context.push(chatMissNote(t, problem))
    }

    if (!isSnapshotSent) {
      isSnapshotSent = true
      context.push(`[agentd] 当前 ticket 总览：\n${overview(await read($, tickets))}`)
    }
    const waiting = await kit.takeEvents()
    if (waiting.length > 0) {
      context.push(digest(waiting))
    }
    return next({ ...e, context })
  }).catch(($, e, next) => next(e))

  // One hook for every call: the Router's own tools are answered here, and the
  // tools that do work are refused, since Workers do the work.
  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    if (name.startsWith(TOOL_PREFIX)) {
      if (!kit) return { deny: 'agentd Router 未启用' }
      return kit.runTool(name.slice(TOOL_PREFIX.length), e as unknown as Record<string, unknown>)
    }
    if (kit && DENIED.has(name)) {
      return {
        deny: `${PLUGIN}：Router 不直接干活。需要读代码、改文件或跑命令，请用 dispatch 派给 Worker。`,
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ---- commands -----------------------------------------------------------

  on('command.run', { command: 'next' }, async $ => {
    if (!kit) return { text: '这个会话不是 agentd Router。' }
    await kit.refresh()
    const t = nextTicket(await read($, tickets), (await read($, chat))?.ticket ?? null)
    if (!t) return { text: '没有等你处理的奏折。' }
    await update($, chat, () => ({ ticket: t.id, isAuto: false }))
    return { text: card(t) }
  })

  on('command.run', { command: 'ticket' }, async ($, e) => {
    if (!kit) return { text: '这个会话不是 agentd Router。' }
    const t = await kit.ticketById(Number(e.args.replace('#', '').trim()))
    if (!t) return { text: `没有奏折 #${e.args.trim()}` }
    await update($, chat, () => ({ ticket: t.id, isAuto: false }))
    return { text: card(t) }
  })

  on('command.run', { command: 'router' }, async $ => {
    await update($, chat, () => null)
    return { text: '已结束单聊，你的话回到 Router。' }
  })

  on('command.run', { command: 'tickets' }, async $ => {
    if (!kit) return { text: '这个会话不是 agentd Router。' }
    await kit.refresh()
    return { text: overview(await read($, tickets)) }
  })

  on('command.run', { command: 'r' }, async ($, e) => {
    const text = e.args.trim()
    if (!text) return { text: '用法：/r 你要对 Router 说的话' }
    void $.prompt.submit({ text, asUser: true })
    return { text: '' }
  })

  on('command.run', { command: 'agentd' }, async ($, e) => {
    if (!kit) return { text: '这个会话不是 agentd Router。' }
    const arg = e.args.trim()
    if (arg === 'start' || arg === 'restart') {
      if (arg === 'restart') {
        const old = await kit.api.get<{ pid?: number }>('/status')
        const isDown = async (): Promise<boolean> => {
          for (let i = 0; i < 20; i++) {
            if (!(await kit!.api.get('/status')).ok) return true
            await $.clock.sleep(250)
          }
          return false
        }
        // Builds older than /shutdown answer it with 404 and keep running, so
        // a daemon that is still up gets SIGTERM by the pid it reported.
        if (old.ok && !((await kit.api.post('/shutdown')).ok && (await isDown()))) {
          const pid = old.data.pid
          if (typeof pid === 'number')
            await $.process.run(['kill', String(pid)], { timeoutMs: 5_000 })
          if (!(await isDown())) {
            return {
              text: `旧的 agentd（pid ${pid ?? '未知'}）没有退出，手动结束它后再 /agentd start。`,
            }
          }
        }
      }
      const up = await kit.startDaemon()
      await update($, daemon, () => (up ? 'up' : 'down') as Daemon)
      return {
        text: up ? 'agentd 已在线。' : `agentd 没能启动，看 ${kit.agentdHome}/logs/daemon.log`,
      }
    }
    const r = await kit.api.get<Record<string, unknown>>(kit.statusPath)
    return {
      text: r.ok
        ? `agentd 在线：${JSON.stringify(r.data)}${r.data.isStale ? '\n守护进程跑的是旧构建，/agentd restart 换新。' : ''}`
        : `agentd 不在线（${r.reason}）。/agentd start 启动。`,
    }
  })

  // ---- drawing ------------------------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!kit || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const view = bandView(
      await read($, daemon),
      await read($, tickets),
      (await read($, chat))?.ticket ?? null,
      (await read($, queue)).length,
    )
    // A filled band reads apart from the prompt box; the fill says the mode.
    // It wraps rather than truncates: a long title must not hide the counts.
    return (
      <Box backgroundColor={bandFill(view)} paddingX={1}>
        <Text color="inverseText" bold wrap="wrap">
          {bandLine(view)}
        </Text>
      </Box>
    )
  })

  // Each ticket the Router speaks of gets a frame of its own, in the colour of
  // its state now, as its card in the Pane: yellow it asks, green it is ready.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!kit || e.props.isSummary) return next(e)
    const { lead, sections } = ticketSections(e.props.text)
    if (sections.length === 0) return next(e)
    const { Box, Markdown, Text } = $.ui.resolve(e)
    const list = await read($, tickets)
    // Read while drawing, so a chat opened or left redraws the replies: the
    // ticket chatted with is framed orange, as its card in the Pane. VS Code
    // has no jump to an older reply, so this marks where to look instead.
    const chatting = (await read($, chat))?.ticket ?? null
    // A ticket gone from the list (ended over a day ago) is history: grey.
    const tone = (id: number): string => {
      if (id === chatting) return 'claude'
      const t = list.find(x => x.id === id)
      return t ? stateLook(t.state).color : 'subtle'
    }
    return (
      <Box flexDirection="column" gap={1}>
        {lead && <Markdown key="lead" text={lead} />}
        {sections.map((part, i) => (
          <Box
            key={`s-${i}`}
            flexDirection="column"
            borderStyle="round"
            borderColor={tone(part.id)}
            paddingX={2}
            paddingY={1}
          >
            {part.id === chatting && (
              <Text key={`c-${i}`} color="claude" bold size="caption">
                ▶ 单聊中
              </Text>
            )}
            <Markdown key={`m-${i}`} text={part.text} />
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    if ((await read($, daemon)) === 'down') {
      return (
        <Box flexDirection="column">
          <Text color="error">agentd 守护进程不在线。</Text>
          <Button
            key="start"
            label="启动"
            variant="primary"
            onPress={async () => {
              const up = (await kit?.startDaemon()) ?? false
              await update($, daemon, () => (up ? 'up' : 'down') as Daemon)
            }}
          />
        </Box>
      )
    }
    const list = await read($, tickets)
    if (list.length === 0) return <Text dimColor>还没有奏折。在下面告诉 Router 要做什么。</Text>
    const chatting = (await read($, chat))?.ticket ?? null
    const confirming = await read($, confirmStop)
    const discarding = await read($, confirmDiscard)
    const live = (await read($, activity)).items
    const shownWhole = await read($, unfolded)
    const isBrief = await read($, isWorkingBrief)
    const now = await $.clock.now()
    const ended = list.filter(t => t.state === 'done' || t.state === 'stopped')
    const endedView = endedPage(ended, await read($, endedAt))
    const groups: [string, string, TicketLite[], number][] = [
      ['待我处理', 'warning', list.filter(t => t.needsMe), 0],
      [WORKING, 'suggestion', list.filter(t => t.state === 'working' || t.state === 'queued'), 0],
      ['已结束 · 24 小时内', 'subtle', endedView.rows, ended.length],
    ]
    const isLive = (t: TicketLite): boolean => t.state !== 'done' && t.state !== 'stopped'

    // A row spaces its items with columnGap, never gap: VS Code wraps a row by
    // default, and a gap there parts its wrapped lines a whole row.
    // Badge, title; project tag, state, age: what a ticket is, read in one look.
    // `tail` ends the second line: an ended ticket's few controls sit there.
    const head = (t: TicketLite, tail?: RenderChildren) => {
      const look = stateLook(t.state)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Text backgroundColor={look.color} color="inverseText" bold>
              {` #${t.id} `}
            </Text>
            <Text size="heading" bold dimColor={!isLive(t)}>
              {t.title}
            </Text>
          </Box>
          <Box flexDirection="row" columnGap={1} flexWrap="wrap" alignItems="center">
            <Text backgroundColor={projectColor(t.project)} color="#FFFFFF">
              {` ${t.project} `}
            </Text>
            <Text color={look.color}>
              {look.glyph} {phaseWord(t)}
            </Text>
            {t.readonly && <Text color="subtle">只读</Text>}
            {t.worktree && t.branch && <Text color="subtle">⎇ {t.branch}</Text>}
            <Text dimColor>· {ago(now - t.updatedAt)}</Text>
            {t.id === chatting && (
              <Text color="claude" bold>
                ▶ 单聊中
              </Text>
            )}
            {tail}
          </Box>
        </Box>
      )
    }

    // A permission answered from the Pane: the Router keeps a line of it, and a
    // chat the question opened ends with it, as when the answer is typed.
    const answerFromPane = async (t: TicketLite, text: '批准' | '拒绝'): Promise<void> => {
      const r = await kit?.runTool('answer', { ticket: t.id, answer: text })
      if (!r) return
      if ('deny' in r) {
        $.ui.toast(r.deny)
        return
      }
      await $.session.append({
        message: {
          type: 'user',
          content: [
            { type: 'text', text: `[agentd] 用户在面板上${text}了 ${header(t)} 的权限请求` },
          ],
        },
      })
      if ((await read($, chat))?.isAuto) await kit?.endChat(t.id)
      $.ui.toast(`已${text} ${header(t)}`)
    }

    // A working Worker's last two lines and their age: proof it is alive. Each is
    // cut to one line and replaced at every step, so it is labelled apart from
    // the message, which is whole.
    const moveOf = (t: TicketLite) =>
      t.state === 'working' ? live.find(x => x.ticketId === t.id) : undefined
    // How long ago it last moved: dim, or the warning colour once quiet for minutes.
    const lastMove = (t: TicketLite) => {
      const at = moveOf(t)?.at
      if (at === undefined || at === null) return null
      const quiet = now - at
      const isQuiet = quiet >= QUIET_MS
      return (
        <Text size="caption" color={isQuiet ? 'warning' : undefined} dimColor={!isQuiet}>
          {isQuiet
            ? `⚠ 已 ${Math.floor(quiet / 60_000)} 分钟没有新动作`
            : `● 最近动作 ${seconds(quiet)}`}
        </Text>
      )
    }
    const pulse = (t: TicketLite) => {
      const a = moveOf(t)
      if (!a || a.lines.length === 0) return null
      return (
        <Box flexDirection="column">
          <Text dimColor size="caption">
            实时动作
          </Text>
          {a.lines.map((line, i) => (
            <Text key={`p-${t.id}-${i}`} dimColor>
              {line}
            </Text>
          ))}
          {lastMove(t)}
        </Box>
      )
    }

    // The rare and the light controls as bare text links. VS Code frames every
    // Button, plain or not, with no room above or below its label; a pressable
    // markdown link is the one control it draws without a frame. The Box
    // shrinks to the link, since the markdown itself spans its row.
    const textLink = (
      key: string,
      label: string,
      onPress: (e: UiPressArgument) => void,
      dimColor = true,
    ) => (
      <Box key={`${key}-at`}>
        <Markdown
          key={key}
          text={`[${label}](${LINK}${key})`}
          dimColor={dimColor}
          onLinkPress={(_, e) => onPress(e)}
        />
      </Box>
    )

    // A link at a line's end, behind its dot: the two wrap as one, never apart.
    const dotLink = (
      key: string,
      label: string,
      onPress: (e: UiPressArgument) => void,
      dimColor = true,
    ) => (
      <Box key={`${key}-dot`} flexDirection="row" columnGap={1} alignItems="center">
        <Text dimColor>·</Text>
        {textLink(key, label, onPress, dimColor)}
      </Box>
    )

    // A message surely past FOLD_ROWS rows folds to them; a new message folds again,
    // since a card unfolds on the message it showed. Questions never fold: the
    // person acts on them, so they show whole.
    const isFoldable = (t: TicketLite): boolean =>
      !t.question && !!t.lastReport && isLong(t.lastReport, e.props.bodyColumns)
    const isFolded = (t: TicketLite): boolean => isFoldable(t) && shownWhole[t.id] !== t.lastReport
    const toggleFold = (t: TicketLite) =>
      update($, unfolded, map => {
        const { [t.id]: shown, ...rest } = map
        return shown === t.lastReport ? rest : { ...rest, [t.id]: t.lastReport ?? '' }
      })

    // Whole and drawn: a Worker writes its reports in markdown.
    const body = (t: TicketLite) =>
      t.question ? (
        <Box flexDirection="column">
          <Text color="warning" bold size="caption">
            {t.isPermission ? '它要权限' : '它在问你'}
          </Text>
          <Markdown key={`q-${t.id}`} text={t.question} />
          {t.options && t.options.length > 0 && !t.isPermission && (
            <Text dimColor>可选：{t.options.join(' · ')}</Text>
          )}
        </Box>
      ) : t.lastReport ? (
        <Box flexDirection="column">
          <Text dimColor size="caption">
            {t.state === 'ready' ? '交付说明' : '最近消息'}
          </Text>
          <Box
            key={`report-${t.id}`}
            flexDirection="column"
            {...(isFolded(t) ? { height: FOLD_ROWS, overflow: 'hidden' as const } : {})}
          >
            <Markdown key={`r-${t.id}`} text={t.lastReport} />
          </Box>
          {/* One switch, where the text is cut, as Claude Code's "… +N lines". */}
          {isFoldable(t) && (
            <Box flexDirection="row" justifyContent="flex-end" marginTop={1}>
              {textLink(`fold-${t.id}`, isFolded(t) ? '… 展开全文' : '收起', () => toggleFold(t))}
            </Box>
          )}
          {t.lastAnswer && <Text dimColor>你答：{t.lastAnswer}</Text>}
        </Box>
      ) : null

    // A card's controls in three weights: the one press its state asks for
    // (primary), the ways into its Worker (buttons), then the rare and the
    // risky as dim links last. A confirm says its cost on a line above, so the
    // row keeps its width.
    const chatPress = async (t: TicketLite) => {
      const isLeaving = t.id === chatting
      await update($, chat, () => (isLeaving ? null : { ticket: t.id, isAuto: false }))
      // One short log line, the one row VS Code draws for a plugin at the
      // conversation's end: where the words now go, and where above to look.
      // The card itself stays in the Pane; the replies above are framed orange.
      if (isLeaving) {
        $.ui.log('已结束单聊，你的话回到 Router。')
        return
      }
      $.ui.log(chatNote(t, mentionDepth(await $.session.messages().catch(() => []), t.id)))
    }
    const toast = (r: ToolAnswer | undefined) => {
      if (r) $.ui.toast('result' in r ? r.result : r.deny)
    }
    const actions = (t: TicketLite) => {
      const isChatting = t.id === chatting
      const isAsked = !!t.question && !t.isPermission
      const canRetry =
        (t.state === 'failed' || t.state === 'blocked') && (!t.workerBgId || t.workerSessionId)
      const primary = [
        t.isPermission && (
          <Button
            key={`approve-${t.id}`}
            label="批准"
            variant="primary"
            onPress={() => answerFromPane(t, '批准')}
          />
        ),
        t.isPermission && (
          <Button key={`reject-${t.id}`} label="拒绝" onPress={() => answerFromPane(t, '拒绝')} />
        ),
        t.state === 'ready' && t.worktree && !t.mrOpened && (
          <Button
            key={`mr-${t.id}`}
            label="开 MR"
            variant="primary"
            onPress={async () => toast(await kit?.runTool('open_mr', { ticket: t.id }))}
          />
        ),
        t.state === 'ready' && !t.worktree && (
          <Button
            key={`close-${t.id}`}
            label="收"
            variant="primary"
            onPress={async () => {
              await kit?.runTool('close', { ticket: t.id })
            }}
          />
        ),
        canRetry && (
          <Button
            key={`retry-${t.id}`}
            label="重试"
            variant="primary"
            onPress={async () => toast(await kit?.runTool('retry', { ticket: t.id }))}
          />
        ),
      ].filter(Boolean)
      // Rare or risky: dim until the pointer or the focus is on them.
      const links = [
        textLink(`copy-${t.id}`, '复制', async press => {
          const r = await $.ui.copy({ text: cardText(t), surface: press.surface })
          $.ui.toast(r.isCopied ? `已复制 ${header(t)}` : `没能复制（${r.reason}）`)
        }),
        t.worktree && t.branch
          ? textLink(
              `discard-${t.id}`,
              discarding === t.id ? '确认放弃' : '放弃',
              async () => {
                if ((await read($, confirmDiscard)) !== t.id) {
                  await update($, confirmDiscard, () => t.id)
                  return
                }
                await update($, confirmDiscard, () => null)
                toast(await kit?.runTool('close', { ticket: t.id, discard: true }))
              },
              discarding !== t.id,
            )
          : null,
        textLink(
          `stop-${t.id}`,
          confirming === t.id ? '确认停止' : '停',
          async () => {
            if ((await read($, confirmStop)) !== t.id) {
              await update($, confirmStop, () => t.id)
              return
            }
            await update($, confirmStop, () => null)
            await kit?.runTool('stop', { ticket: t.id })
          },
          confirming !== t.id,
        ),
      ].filter(x => x !== null)
      const warning =
        discarding === t.id && t.worktree && t.branch
          ? '再点一次「确认放弃」：会删掉 worktree 和分支'
          : confirming === t.id
            ? '再点一次「确认停止」：Worker 会被停下'
            : null
      return (
        <Box flexDirection="column">
          {warning && <Text color="warning">{warning}</Text>}
          <Box flexDirection="row" columnGap={2} flexWrap="wrap" alignItems="center">
            <Box flexDirection="row" columnGap={1}>
              {primary}
              <Button
                key={`chat-${t.id}`}
                label={isChatting ? '单聊中' : '单聊'}
                {...(isAsked && !isChatting ? { variant: 'primary' as const } : {})}
                onPress={() => chatPress(t)}
              />
              {t.workerSessionId && (
                <Button key={`open-${t.id}`} label="打开" onPress={() => kit?.open(t)} />
              )}
            </Box>
            <Box flexDirection="row" columnGap={1} alignItems="center">
              {links.flatMap((link, i) =>
                i === 0
                  ? [link]
                  : [
                      <Text key={`dot-${t.id}-${i}`} dimColor>
                        ·
                      </Text>,
                      link,
                    ],
              )}
            </Box>
          </Box>
        </Box>
      )
    }

    // Groups stand further apart than the cards within one.
    return (
      <Box flexDirection="column" gap={2}>
        {groups
          .filter(([, , rows]) => rows.length > 0)
          .map(([title, tone, rows, total]) => (
            <Box key={`g-${title}`} flexDirection="column" gap={1}>
              <Box flexDirection="row" columnGap={1} alignItems="center">
                <Text color={tone} bold>
                  ▍{title}
                </Text>
                <Text color={tone}>{total || rows.length}</Text>
                {title === WORKING && <Box flexGrow={1} />}
                {title === WORKING &&
                  textLink('working-view', isBrief ? '完整显示' : '极简显示', () =>
                    update($, isWorkingBrief, () => !isBrief),
                  )}
              </Box>
              {rows.map(t =>
                // Brief, a working ticket reads as an ended one does, with the age
                // of its last move under it: the rest is a press away, in 完整显示.
                isBrief && title === WORKING && isLive(t) ? (
                  <Box key={`t-${t.id}`} flexDirection="column" paddingX={1}>
                    {head(t, [
                      dotLink(
                        `chat-${t.id}`,
                        t.id === chatting ? '单聊中' : '单聊',
                        () => chatPress(t),
                        t.id !== chatting,
                      ),
                      t.workerSessionId && dotLink(`open-${t.id}`, '打开', () => kit?.open(t)),
                    ])}
                    {lastMove(t)}
                  </Box>
                ) : // An ended ticket is a line of history, not a card to act on.
                !isLive(t) ? (
                  <Box key={`t-${t.id}`} flexDirection="column" paddingX={1}>
                    {head(
                      t,
                      t.workerSessionId && [
                        dotLink(`open-${t.id}`, '打开', () => kit?.open(t)),
                        t.state === 'stopped' && t.workerBgId && (
                          <Button
                            key={`resume-${t.id}`}
                            label="恢复"
                            onPress={async () => {
                              const r = await kit?.runTool('resume', { ticket: t.id })
                              if (r) $.ui.toast('result' in r ? r.result : r.deny)
                            }}
                          />
                        ),
                      ],
                    )}
                  </Box>
                ) : (
                  <Box
                    key={`t-${t.id}`}
                    flexDirection="column"
                    gap={1}
                    borderStyle="round"
                    borderColor={t.id === chatting ? 'claude' : stateLook(t.state).color}
                    paddingX={2}
                    paddingY={1}
                  >
                    {head(t)}
                    {body(t)}
                    {pulse(t)}
                    {actions(t)}
                  </Box>
                ),
              )}
              {total > 0 && endedView.pages > 1 && (
                <Box flexDirection="row" columnGap={1} paddingX={1}>
                  {endedView.page > 0 && (
                    <Button
                      key="ended-prev"
                      label="上一页"
                      onPress={() => update($, endedAt, () => endedView.page - 1)}
                    />
                  )}
                  <Text dimColor>{`第 ${endedView.page + 1} / ${endedView.pages} 页`}</Text>
                  {endedView.page < endedView.pages - 1 && (
                    <Button
                      key="ended-next"
                      label="下一页"
                      onPress={() => update($, endedAt, () => endedView.page + 1)}
                    />
                  )}
                </Box>
              )}
            </Box>
          ))}
      </Box>
    )
  })
}
