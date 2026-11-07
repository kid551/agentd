import type { EventLite, TicketLite } from '../types'

// Everything the mod says, as pure functions of the state, so tests read them
// without a session.

export const ROUTER_PROMPT = `# 你是 agentd 的 Router

用户只跟你一个人说话。你手下有若干 Worker，每个 Worker 是一个在某个项目目录里干活的独立 Claude Code 会话，对应一张 ticket（#号）。对用户说话时，ticket 一律叫「奏折」。

## 你只做三件事
1. 派工：用户要做事时，调 agentd 的 dispatch 工具开 ticket。项目名有歧义或范围不清，先问用户一次，不要猜。title 用一句不超过 30 字的中文概括。prompt 写成 Worker 能独立执行的完整任务描述，保留用户原话里的约束。
   用户要接着一张已结束、收掉的旧 ticket 做，开新 ticket 并带 follows=旧号，prompt 里写清上次做到哪（先 read 它）。
2. 转述：Worker 的提问、交付、受阻，会以「[agentd] N 条新事件」的消息送到你这里。逐条转述给用户。
3. 路由：用户的回答、追加指令、验收、叫停，用 answer / message / close / stop 送到对应 ticket。Worker 提问后不会停下来干等，所以有待答问题时也能用 message 追加指令；但用户的话是在回答那个问题时，用 answer。权限请求例外：Worker 停在那里等审批，只能用 answer。

## 你不做的事
- 不读代码、不改文件、不跑命令：这些工具对你是禁用的。需要动手就派给 Worker。
- 不凭记忆回答 ticket 的细节，先调 read 工具。用户提起的旧任务不在进行中，用 find 按关键词或项目找；read 的结果里带着下一步能读的号和参数，顺着读，不要猜。
- 不替用户拍板 Worker 的问题，也不替用户批准权限请求。

## 说话方式
- 每次回复不超过 100 词。提到 ticket 永远以「#号 · 项目 · 标题」开头，让用户一眼知道在说哪个。
- 一次只问用户一个问题。多个 ticket 同时需要用户时，按顺序一个一个来，先说一共几个。
- 用户可以和某个 ticket「单聊」：那时用户的话直接发给该 ticket 的 Worker，不经过你，你只会看到一条「[agentd] 用户直接对 #号…」的记录。发到你这里的话没指明 ticket 时，拿不准就问。
- ready 的 ticket：转述 Worker 写的「改了什么、怎么验证、看哪里」，问用户是否验收。用户说收了就 close。
- 以「**权限请求**」开头的问题，是 Worker 的某个操作被自动权限审查拒绝了，在等用户批准。照原样转述要执行的命令或文件和被拒的理由，问用户批不批准。用户同意就用 answer 回「批准」，否则回「拒绝」，不要回别的字。批准只放行这一次、这一条操作。
- blocked 或 failed 的 ticket，如果卡在权限上（例如 Worker 说操作被权限审查拦下），告诉用户可以「重试」：retry 会让 Worker 接着原来的会话重启，这次被拒的操作会转给用户批准。
- stopped（已停）的 ticket 是用户中途叫停的。用户要接着做时用 resume：Worker 接着原会话恢复，先自查现场、汇报，再问用户下一步。不要对已停的用 retry 或 message。

## 只读奏折与 MR 奏折
- 派工时判断是不是只读：用户要的只是调研、查询、排查原因、读代码回答问题，不要求改任何东西，就设 readonly=true。只读 Worker 写不了文件，也不占项目，同项目有别的奏折在做也能马上开始。拿不准就不设。
- 有的项目是 MR 项目：那里写代码的奏折各自在自己的 worktree 和分支里做，同项目可以几张同时做，不用等。这类奏折在总览里标着 MR。
- MR 奏折 ready 时叫「待审」：转述交付，问用户要不要开 MR。用户同意就调 open_mr，之后 Worker 自己 commit、push、开 MR、盯流水线到合入。合入后奏折自动结束，worktree 和分支自动清理，不用 close。用户同意时还交代了别的（例如「先验证，然后开 MR」），把那些话写进 open_mr 的 text，不要改用 message 转达：agentd 只凭 open_mr 记下用户同意，Worker 也只认它。
- 合入前用户说收了、不要了，就是放弃这份改动：先跟用户确认「会删掉这张奏折的 worktree 和分支，改动不保留」，用户确认后 close 带 discard=true。
- 纯文档或很小的改动，如果同项目已经有一张在做的 MR 奏折，建议用户并进那张（用 message 追加给它），而不是单独开一个 MR：有的项目 main 每进一个提交都要重跑整条流水线。`

export const COMPACT_NOTE =
  '保留：所有仍未结束的 ticket 号、标题与状态，用户最近的指示，以及用户最近单聊的 ticket。ticket 细节可以丢，事后用 agentd 的 read 工具取回，已结束的用 find 找回。'

const STATE_WORDS: Record<TicketLite['state'], string> = {
  queued: '排队',
  working: '在干',
  asking: '提问',
  ready: '就绪',
  blocked: '受阻',
  failed: '失败',
  done: '已结束',
  stopped: '已停',
}

const KIND_WORDS: Record<string, string> = {
  ask: 'Worker 提问',
  ready: '已就绪，待验收',
  blocked: '受阻',
  failed: '失败',
  dropped: 'Worker 判断无事可做，已结束',
  stalled: 'Worker 停下但没有汇报',
  exited: 'Worker 进程异常退出',
  spawn_failed: '启动失败',
  merged: 'MR 已合入，奏折已结束',
  kept: 'worktree 没能自动清理，留给用户处理',
}

export const stateWord = (state: TicketLite['state']): string => STATE_WORDS[state]

/** The state as the person reads it: an MR ticket's phase has words of its own. */
export const phaseWord = (t: Pick<TicketLite, 'state' | 'worktree' | 'mrOpened'>): string => {
  if (t.worktree && t.state === 'ready' && !t.mrOpened) return '待审'
  if (t.worktree && t.mrOpened && (t.state === 'working' || t.state === 'asking'))
    return t.state === 'asking' ? 'MR 中 · 提问' : 'MR 中'
  return STATE_WORDS[t.state]
}

/**
 * Starts an MR ticket's phase b. Its prefix is the one the Worker's rule 3
 * names (packages/agentd/src/lane-rules.ts, `openMrText`); a mod imports no
 * other package, so the words are kept in step by hand.
 */
export const openMrMessage = (id: number, branch: string, note = ''): string =>
  `【奏折 #${id} 开 MR】用户审过了你交回的改动，同意开 MR。按规则 3 b 做：commit，推到 \`${branch}\`，开向 main 的 MR（合入后删除源分支），盯到合入后 done（outcome=merged）。` +
  (note.trim() ? `\n\n用户另外交代：${note.trim()}` : '')

/**
 * A state's color and glyph in the Pane. Theme keys, so they follow the
 * person's light or dark theme; the glyph tells states apart without color.
 */
const STATE_LOOKS: Record<TicketLite['state'], { color: string; glyph: string }> = {
  asking: { color: 'warning', glyph: '?' },
  ready: { color: 'success', glyph: '✓' },
  blocked: { color: 'error', glyph: '!' },
  failed: { color: 'error', glyph: '✕' },
  working: { color: 'suggestion', glyph: '●' },
  queued: { color: 'subtle', glyph: '○' },
  done: { color: 'success', glyph: '✓' },
  stopped: { color: 'inactive', glyph: '■' },
}

export const stateLook = (state: TicketLite['state']): { color: string; glyph: string } =>
  STATE_LOOKS[state]

/**
 * Deep tones that white text reads on, in light and dark themes alike, and
 * none of them a state's yellow, green, red or orange.
 */
const PROJECT_COLORS = ['#7C3AED', '#0E7490', '#BE185D', '#4338CA', '#0F766E', '#A21CAF', '#0369A1']

/** The same project is always the same color. */
export function projectColor(project: string): string {
  let hash = 0
  for (const ch of project) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return PROJECT_COLORS[hash % PROJECT_COLORS.length] as string
}

/** How long ago, as a person says it. */
export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`
}

/** Like `ago`, but counts seconds under a minute: a live Worker's last move. */
export const seconds = (ms: number): string =>
  ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))} 秒前` : ago(ms)

export const header = (t: { id: number; project: string; title: string }): string =>
  `#${t.id} · ${t.project} · ${t.title}`

export const ENDED_PAGE_SIZE = 10

/** One page of ended tickets, newest number first; a page past the end shows the last. */
export function endedPage(
  ended: TicketLite[],
  page: number,
): { rows: TicketLite[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(ended.length / ENDED_PAGE_SIZE))
  const at = Math.min(Math.max(0, page), pages - 1)
  const rows = [...ended]
    .sort((a, b) => b.id - a.id)
    .slice(at * ENDED_PAGE_SIZE, (at + 1) * ENDED_PAGE_SIZE)
  return { rows, page: at, pages }
}

/** A ticket's task shows this long in read summary; what=prompt gives it whole. */
export const PROMPT_CHARS = 1200

/** Another ticket as a summary names it: one hop along the chain of recall. */
export type Brief = { id: number; title: string; project: string; state: TicketLite['state'] }

/** The lines read summary gives for the ticket this one carries on and the ones carrying it on. */
export function linkLines(follows: Brief | null | undefined, followers: Brief[] = []): string[] {
  const lines: string[] = []
  if (follows) lines.push(`接续自：${header(follows)}（${stateWord(follows.state)}）`)
  if (followers.length > 0)
    lines.push(`后续：${followers.map(f => `${header(f)}（${stateWord(f.state)}）`).join('；')}`)
  return lines
}

/** The task as read summary shows it: cut, with the way to the whole. */
export function promptLine(id: number, prompt: string): string {
  if (prompt.length <= PROMPT_CHARS) return `任务：${prompt}`
  return `任务：${prompt.slice(0, PROMPT_CHARS)}…（共 ${prompt.length} 字，已截断，read ticket=${id} what=prompt 取全文）`
}

export type EventRow = { id: number; kind: string; actor: string; body: { text?: string } }

/** read what=events: oldest first, and how to go further back when there is more. */
export function eventsText(id: number, events: EventRow[], more: boolean): string {
  const lines = events.map(ev => `${ev.kind}（${ev.actor}）：${ev.body.text ?? ''}`)
  const first = events[0]
  if (more && first) lines.unshift(`（更早还有：read ticket=${id} what=events before=${first.id}）`)
  return lines.join('\n') || '没有事件。'
}

export type TranscriptRow = {
  role: string
  text: string
  tools: string[]
  /** Absent from daemons older than transcript paging. */
  at?: number
  isCut?: boolean
}

/** read what=transcript: a cut row says how to read it whole, the page how to go back. */
export function transcriptText(id: number, rows: TranscriptRow[], more: boolean): string {
  const lines = rows.map(row => {
    const tools = row.tools.length ? ` [${row.tools.join(', ')}]` : ''
    const whole =
      row.isCut && row.at !== undefined
        ? `…（已截断，read ticket=${id} what=transcript row=${row.at} 取全文）`
        : ''
    return `${row.role}${tools}：${row.text}${whole}`
  })
  const first = rows[0]
  if (more && first?.at !== undefined)
    lines.unshift(`（更早还有：read ticket=${id} what=transcript before=${first.at}）`)
  return lines.join('\n') || '没有会话记录。'
}

/** find: one line a ticket, newest first, ended ones with the day they ended. */
export function foundText(
  tickets: (TicketLite & { followsId?: number | null; endedAt?: number | null })[],
): string {
  if (tickets.length === 0) return '没有找到。换个关键词，或去掉项目再找。'
  return tickets
    .map(t => {
      const day = t.endedAt ? new Date(t.endedAt) : null
      const when = day ? ` · ${day.getMonth() + 1}月${day.getDate()}日结束` : ''
      const from = t.followsId ? ` · 接续 #${t.followsId}` : ''
      const last = t.lastReport ? ` · ${t.lastReport.slice(0, 120)}` : ''
      return `${header(t)}（${phaseWord(t)}${when}）${from}${last}`
    })
    .join('\n')
}

/** One message for the Router holding every event that waited (batching). */
export function digest(events: EventLite[]): string {
  const lines = events.map(e => {
    const more = e.isCut ? `（已截断，全文用 read 工具取 #${e.ticketId}）` : ''
    const prior = e.priorReport ? `\n  此前进展：${e.priorReport}` : ''
    return `【${header({ id: e.ticketId, project: e.project, title: e.title })}】${KIND_WORDS[e.kind] ?? e.kind}：${e.summary}${more}${prior}`
  })
  return `[agentd] ${events.length} 条新事件\n${lines.join('\n')}\n\n按 Router 规则转述给用户：每个 ticket 一段，以 #号开头。`
}

export function overview(tickets: TicketLite[]): string {
  const live = tickets.filter(t => t.state !== 'done' && t.state !== 'stopped')
  if (live.length === 0) return '没有进行中的奏折。'
  const order = (t: TicketLite): number => (t.needsMe ? 0 : 1)
  return [...live]
    .sort((a, b) => order(a) - order(b) || a.id - b.id)
    .map(t => {
      const tail = t.question ? ` · 问：${t.question}` : t.lastReport ? ` · ${t.lastReport}` : ''
      const tag = t.readonly ? ' · 只读' : t.worktree ? ' · MR' : ''
      return `${header(t)}（${phaseWord(t)}${tag}）${tail.slice(0, 160)}`
    })
    .join('\n')
}

/** What the Router reads beside words meant for a chatted ticket that its Worker never got. */
export function chatMissNote(t: TicketLite, problem: string): string {
  return `[agentd] 用户正在单聊 ${header(t)}（${phaseWord(t)}），但这句话没能直接发给它的 Worker（${problem}）。请你处理，多半是给它的指令。`
}

/** The ticket /next moves to: the oldest question first, then the oldest other handoff. */
export function nextTicket(tickets: TicketLite[], after: number | null): TicketLite | undefined {
  const waiting = tickets
    .filter(t => t.needsMe)
    .sort((a, b) => {
      const rank = (t: TicketLite): number => (t.state === 'asking' ? 0 : 1)
      return rank(a) - rank(b) || a.updatedAt - b.updatedAt
    })
  return waiting.find(t => t.id !== after) ?? waiting[0]
}

/** The question to take the chat when one is answered: the longest waiting. */
export function nextAsking(tickets: TicketLite[], after: number): TicketLite | undefined {
  return tickets
    .filter(t => t.question !== null && t.id !== after)
    .sort((a, b) => a.updatedAt - b.updatedAt)[0]
}

/** The card /next and /ticket print for a ticket. */
export function card(t: TicketLite): string {
  if (t.question) {
    if (t.isPermission)
      return `${header(t)}\n${t.question}\n\n输入「批准」放行这一次，其他回答都算拒绝。`
    const options = t.options
      ? `\n选项：${t.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('  ')}`
      : ''
    return `${header(t)}\n问：${t.question}${options}\n\n直接输入就是回答它。`
  }
  const report = t.lastReport ? `\n${t.lastReport}` : ''
  return `${header(t)}（${phaseWord(t)}）${report}\n\n直接输入就是对它的 Worker 说。`
}

/** Rows a folded message shows. */
export const FOLD_ROWS = 4

// Where a card's text links point: a press runs the plugin's own closure and
// opens nothing; `.invalid` never resolves, should a surface open it anyway.
export const LINK = 'https://agentd.invalid/'

/** A live card's frame and padding: 1 + 2 cells a side in the terminal, 2 ch a side in VS Code. */
const CARD_INSET = 4
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u

/** The narrowest a line can draw: 1.6 cells a CJK character, 0.45 any other, markup none. */
function narrowest(line: string): number {
  const shown = line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
  let width = 0
  for (const ch of shown) width += WIDE.test(ch) ? 1.6 : 0.45
  return width
}

/**
 * Whether a markdown message surely draws more than FOLD_ROWS rows in a card
 * `columns` wide. The host tells a mod no drawn height, and VS Code draws in
 * a proportional font, so this counts the fewest rows it could take: one per
 * block (paragraph, list item, heading, quote line, table row, code line),
 * and a paragraph's narrowest width over the widest the card can be. Never
 * true for a message that fits; one a row or so past FOLD_ROWS may stay whole.
 */
export function isLong(text: string, columns: number): boolean {
  const room = columns - CARD_INSET
  const rowsOf = (width: number): number => (room > 0 ? Math.max(1, Math.ceil(width / room)) : 1)
  let rows = 0
  let paragraph: number | null = null
  let isCode = false
  const endParagraph = (): void => {
    if (paragraph !== null) rows += rowsOf(paragraph)
    paragraph = null
  }
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      endParagraph()
      isCode = !isCode
    } else if (isCode) {
      rows += 1
    } else if (line.trim() === '' || /^\s*([-*_]\s*){3,}$/.test(line)) {
      endParagraph()
    } else if (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line)) {
      // A table's rule row draws nothing.
    } else if (/^\s*(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(line)) {
      endParagraph()
      rows += rowsOf(narrowest(line))
    } else {
      // A soft break joins a paragraph's lines into one.
      paragraph = (paragraph ?? 0) + narrowest(line)
    }
    if (rows > FOLD_ROWS) return true
  }
  endParagraph()
  return rows > FOLD_ROWS
}

/**
 * What a Pane card's 复制 puts on the clipboard: the words the card shows,
 * the message as its markdown source. The VS Code webview draws a Pane
 * unselectable, and a mod cannot style it, so this stands in for a selection.
 */
export function cardText(t: TicketLite): string {
  const title = `${header(t)}（${phaseWord(t)}）`
  if (t.question) {
    const options =
      t.options && t.options.length > 0 && !t.isPermission ? `\n可选：${t.options.join(' · ')}` : ''
    return `${title}\n\n${t.isPermission ? '它要权限' : '它在问你'}：\n${t.question}${options}`
  }
  if (!t.lastReport) return title
  const answer = t.lastAnswer ? `\n你答：${t.lastAnswer}` : ''
  return `${title}\n\n${t.state === 'ready' ? '交付说明' : '最近消息'}：\n${t.lastReport}${answer}`
}

/** The Router's counts, the same in every mode so a chat never hides them. */
type Counts = { needsMe: number; working: number }

export type BandView =
  | { mode: 'down' }
  | ({ mode: 'answering'; ticket: TicketLite } & Counts)
  | ({ mode: 'chatting'; ticket: TicketLite; pending: number } & Counts)
  | ({ mode: 'none'; pending: number } & Counts)

export function bandView(
  daemon: 'up' | 'down' | 'starting',
  tickets: TicketLite[],
  chat: number | null,
  pending: number,
): BandView {
  if (daemon === 'down') return { mode: 'down' }
  const counts: Counts = {
    needsMe: tickets.filter(t => t.needsMe).length,
    working: tickets.filter(t => t.state === 'working' || t.state === 'queued').length,
  }
  const ticket = tickets.find(t => t.id === chat)
  if (ticket?.question) return { mode: 'answering', ticket, ...counts }
  if (ticket) return { mode: 'chatting', ticket, pending, ...counts }
  return { mode: 'none', pending, ...counts }
}

export function bandLine(view: BandView): string {
  const more =
    'pending' in view && view.pending > 0 ? ` · ${view.pending} 条新事件待送达，说句话即可` : ''
  switch (view.mode) {
    case 'down':
      return '⚠ agentd 守护进程不在线 · /agentd start 启动'
    // Two lines in a chat: the ticket on the first, the Router's counts and the
    // hints on the second, so the counts sit in the same place whatever the title.
    case 'answering':
      // The other tickets wait their turn, so no event is for the Router yet.
      return `▶ 单聊 ${header(view.ticket)} · 它在等你回答\n▶ Router ${counts(view)} · 你的话直接发给它（/r 对 Router 说）`
    case 'chatting':
      return `▶ 单聊 ${header(view.ticket)}（${phaseWord(view.ticket)}）\n▶ Router ${counts(view)} · 你的话直接发给它（/r 对 Router 说 · /router 结束单聊）${more}`
    case 'none':
      return `▶ 对 Router 说 · ${counts(view)}${view.needsMe > 0 ? ' · /next 单聊下一个' : ''}${more}`
  }
}

const counts = (c: Counts): string => `待处理 ${c.needsMe} · 进行中 ${c.working}`

/**
 * The band's fill, a theme key, so the colour alone says the mode: orange the
 * words go straight to a Worker; otherwise they go to the Router, yellow when
 * something waits, green when nothing does; red the daemon is away.
 */
export function bandFill(view: BandView): string {
  switch (view.mode) {
    case 'down':
      return 'error'
    case 'answering':
    case 'chatting':
      return 'claude'
    case 'none':
      return view.needsMe > 0 ? 'warning' : 'success'
  }
}

/** A part of a Router reply about one ticket: it opens `#12 · project · title`. */
export type TicketSection = { id: number; project: string; text: string }

/**
 * A line that opens a ticket's part: its header, after any markdown the model
 * put before it (`1. `, `- `, `### `, `**`), in any order.
 */
const SECTION_HEAD = /^\s*(?:\d+[.)、]\s*|[-*+]\s+|#{1,6}\s+|\*\*|__)*#(\d+) · ([^·\n*_]+?) · /

/**
 * Splits a Router reply at each line that opens a ticket's header, as its
 * prompt asks it to write: what comes before the first header, and the parts.
 * No header: no parts, and the reply draws as it is.
 */
export function ticketSections(text: string): { lead: string; sections: TicketSection[] } {
  const lead: string[] = []
  const sections: TicketSection[] = []
  for (const line of text.split('\n')) {
    const head = SECTION_HEAD.exec(line)
    const last = sections.at(-1)
    if (head) sections.push({ id: Number(head[1]), project: head[2] as string, text: line })
    else if (last) last.text += `\n${line}`
    else lead.push(line)
  }
  for (const part of sections) part.text = part.text.trim()
  return { lead: lead.join('\n').trim(), sections }
}

/**
 * How far up the Router last spoke of ticket `id`: the count of its replies
 * with words, from the newest (1) to the one that speaks of it (a section
 * opening `#id · project · `); null when none does.
 */
export function mentionDepth(
  messages: readonly { role: string; text: string }[],
  id: number,
): number | null {
  let depth = 0
  for (const m of [...messages].reverse()) {
    if (m.role !== 'assistant' || !m.text.trim()) continue
    depth += 1
    if (ticketSections(m.text).sections.some(s => s.id === id)) return depth
  }
  return null
}

/**
 * The line the chat button logs on entering a chat: one line, no card (the
 * Pane shows it), saying where the words go and where above to look.
 */
export function chatNote(t: TicketLite, depth: number | null): string {
  const where =
    depth === null
      ? 'Router 还没讲过它'
      : `${depth === 1 ? 'Router 最近一条回复' : `往上数第 ${depth} 条 Router 回复`}讲到它，那一段已框成橙色并标「▶ 单聊中」`
  return `▶ 单聊 ${header(t)}（${phaseWord(t)}）：${where}；你的话直接发给它的 Worker。`
}
