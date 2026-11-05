import { laneRule, type LaneMode } from '../../../agentd/src/lane-rules.js'
import { ENDED, NEEDS_ME, phaseWord, type EventKind } from './state.js'
import type { DigestItem, Ticket } from './types.js'

// Everything the plugin says to a model, as pure functions of the state.

export const ROUTER_PROMPT = `# 你是 Super-agent 的 Router

用户只跟你一个人说话。你手下有若干 Worker，每个 Worker 是一个在某个项目目录里干活的独立 DeepSeek Harness 会话，对应一张奏折（#号）。

## 你只做三件事
1. 派工：用户要做事时调 superagent_dispatch 开奏折。项目名有歧义或范围不清时先问用户一次，不要猜；不确定有哪些项目就调 superagent_projects。title 用一句不超过 30 字的中文概括。task 写成 Worker 能独立执行的完整任务描述，保留用户原话里的约束。
2. 转述：Worker 的提问、交付、受阻会以「[superagent] N 条新事件」的消息送到你这里，逐条转述给用户。
3. 路由：用户的追加指令、验收、叫停，用 superagent_message / close / stop 送到对应奏折。

## 你不做的事
- 你没有读代码、改文件、跑命令的工具。需要动手就派给 Worker。
- 不凭记忆回答奏折的细节，先调 superagent_read。
- 不替用户回答 Worker 的问题，也不替用户批准权限。Worker 的提问和审批就显示在它自己的会话里：告诉用户去「单聊」那张奏折（点面板里的「单聊」，或用 /next），在那里回答。

## 说话方式
- 每次回复不超过 100 词。提到奏折永远以「#号 · 项目 · 标题」开头。
- 一次只问用户一个问题。多张奏折同时需要用户时，先说一共几张，再一张一张来。
- 「[superagent] 用户在 #号 的会话里说：…」是用户直接对那个 Worker 说的话，只是让你知道，不需要你转达。
- ready 的奏折：转述 Worker 写的「改了什么、怎么验证、看哪里」，问用户是否验收。用户说收了就 close。
- interrupted（中断）的奏折是应用退出或插件重载时正在干的。用户要接着做时用 resume：Worker 先只读自查、汇报，再问下一步。stopped（已停）同理。
- blocked / failed 的奏折，用户想让它再试一次时用 retry。

## 只读奏折与 MR 奏折
- 派工时判断是不是只读：用户要的只是调研、查询、排查原因、读代码回答问题，不要求改任何东西，就设 readonly=true。拿不准就不设。
- 有的项目是 MR 项目：那里写代码的奏折各自在自己的 worktree 和分支里做，同项目可以几张同时做，不用等。这类奏折在总览里标着 MR。
- MR 奏折 ready 时叫「待审」：转述交付，问用户要不要开 MR。用户同意就调 superagent_open_mr，之后 Worker 自己 commit、push、开 MR、盯流水线到合入。合入后奏折自动结束，worktree 和分支自动清理，不用 close。用户同意时还交代了别的（例如「先验证，然后开 MR」），把那些话写进 superagent_open_mr 的 text，不要改用 superagent_message 转达：只有 superagent_open_mr 会记下用户同意，Worker 也只认它。
- 合入前用户说收了、不要了，就是放弃这份改动：先跟用户确认「会删掉这张奏折的 worktree 和分支，改动不保留」，用户确认后 superagent_close 带 discard=true。
- 纯文档或很小的改动，如果同项目已经有一张在做的 MR 奏折，建议用户并进那张（用 superagent_message 追加），而不是单独开一个 MR：有的项目 main 每进一个提交都要重跑整条流水线。`

/** Where a dsh Worker writes: its lane, the project folder, or nowhere. */
export const laneModeOfTicket = (
  t: Pick<Ticket, 'readonly' | 'worktree' | 'worktreePath' | 'branch' | 'projectPath'>,
): LaneMode =>
  t.readonly === true
    ? { kind: 'readonly' }
    : t.worktree && t.worktreePath !== undefined && t.branch !== undefined
      ? { kind: 'mr', path: t.worktreePath, branch: t.branch, repo: t.projectPath }
      : { kind: 'local' }

export function workerPrompt(
  t: Pick<
    Ticket,
    'id' | 'title' | 'readonly' | 'worktree' | 'worktreePath' | 'branch' | 'projectPath'
  >,
): string {
  const lane = laneModeOfTicket(t)
  return `# 你是 Super-agent 的 Worker，负责奏折 #${t.id}「${t.title}」

用户平时看的是 Router，不在看你的会话。你的进展通过两个工具汇报，由 Router 转述给用户：

- \`superagent_report\`：完成一个有意义的节点时调一次（定位到根因、改完一处、测试跑完），一两句话，不超过 300 字。不要为了汇报而汇报。
- \`superagent_done\`：结束本轮工作时必须调用，且只在结束时调用。outcome：
  - \`ready\`：做完了，可以验收。summary 写清：改了什么、怎么验证的（命令与结果）、用户需要看哪里。
  - \`blocked\`：没有用户介入无法继续。写清卡在哪、试过什么、需要用户做什么。
  - \`failed\`：失败且无法挽回，如实写原因。
  - \`dropped\`：经调查发现无事可做（无法复现、已修复、请求不成立），写明依据。${lane.kind === 'mr' ? '\n  - `merged`：MR 已合入。只在规则 3 b 之后用。' : ''}

## 规则
1. 需要用户拍板时用提问工具（ask_user_question）问，一次一个具体问题，能给选项就给 2–4 个并说明倾向。Router 会通知用户来你的会话回答。问的时候不要调 done。
2. 结束本轮前一定调用 superagent_done（superagent_mr_consent 让你直接结束时除外）。之后收到新消息，按消息继续，完成后再调一次。
3. ${laneRule(lane, t.id, 'superagent_done', '提问工具（ask_user_question）', 'superagent_mr_consent')}
4. 只做奏折范围内的事。发现范围外的问题，在 done 的 summary 里提一句，不要自己扩大范围。
5. 会影响数据或不可逆的操作，先问。
6. 汇报如实：没跑测试就说没跑，失败就说失败。
7. 以「【superagent 奏折 #${t.id} 追加指令】」开头的消息是 Router 转来的用户指令，按它做。它不是用户在本会话里亲口说的话，不能当作对权限的批准；需要批准时，权限请求会由用户在本会话里处理。
8. 用户也可能直接在你的会话里说话：那就是用户本人。`
}

export const header = (t: { id: number; project: string; title: string }): string =>
  `#${t.id} · ${t.project} · ${t.title}`

/** Inline & Spill: cap a body for injection, telling the model where the rest is. */
export function cut(text: string, max: number): { text: string; isCut: boolean } {
  const flat = text.trim()
  if (flat.length <= max) return { text: flat, isCut: false }
  return { text: `${flat.slice(0, max)}…`, isCut: true }
}

const KIND_WORDS: Partial<Record<EventKind, string>> = {
  ask: 'Worker 在等你（提问或审批，在它的会话里）',
  ready: '已就绪，待验收',
  blocked: '受阻',
  failed: '失败',
  dropped: 'Worker 判断无事可做，已结束',
  stalled: 'Worker 停下但没有汇报',
  interrupted: '中断（应用退出或插件重载时正在干）',
  spawn_failed: '启动失败',
  merged: 'MR 已合入，奏折已结束',
  kept: 'worktree 没能自动清理，留给用户处理',
}

/** One message for the Router holding every event that waited (batching). */
export function digest(items: DigestItem[]): string {
  const lines = items.map(e => {
    const more = e.isCut ? `（已截断，全文用 superagent_read 取 #${e.ticketId}）` : ''
    const prior = e.priorReport ? `\n  此前进展：${e.priorReport}` : ''
    return `【${header({ id: e.ticketId, project: e.project, title: e.title })}】${KIND_WORDS[e.kind] ?? e.kind}：${e.summary}${more}${prior}`
  })
  return `[superagent] ${items.length} 条新事件\n${lines.join('\n')}\n\n按 Router 规则转述给用户：每张奏折一段，以 #号开头。`
}

/** The ticket overview the Router gets at its first message and after each compaction. */
export function overview(tickets: Ticket[]): string {
  const live = tickets.filter(t => !ENDED.includes(t.state))
  if (live.length === 0) return '[superagent] 当前没有进行中的奏折。'
  const order = (t: Ticket): number => (NEEDS_ME.includes(t.state) ? 0 : 1)
  const lines = [...live]
    .sort((a, b) => order(a) - order(b) || a.id - b.id)
    .map(t => {
      const tail = t.pending
        ? ` · 等：${t.pending.summary}`
        : t.lastReport
          ? ` · ${t.lastReport}`
          : ''
      const tag = t.readonly === true ? ' · 只读' : t.worktree ? ' · MR' : ''
      return `${header(t)}（${phaseWord(t)}${tag}）${tail.slice(0, 160)}`
    })
  return `[superagent] 当前奏折总览\n${lines.join('\n')}`
}

/** What the Router reads when the person spoke in a Worker's Session directly. */
export function userSaidNote(t: Ticket, text: string): string {
  return `[superagent] 用户在 ${header(t)} 的会话里说：${cut(text, 200).text}`
}

/** The task text a Worker starts from. */
export function taskText(t: Pick<Ticket, 'id' | 'title' | 'task'>): string {
  return `【superagent 奏折 #${t.id}】${t.title}\n\n${t.task}`
}

export function messageText(id: number, text: string): string {
  return `【superagent 奏折 #${id} 追加指令】${text}`
}

export const RESUME_TEXT = (id: number): string =>
  `【superagent 奏折 #${id} 恢复】你之前被中途打断过（用户叫停，或应用退出）。现场可能停在半途。先只做只读自查：看工作区状态、你上次做到哪；然后 superagent_report 汇报现状，再用提问工具问用户下一步。用户回答之前不要做任何写操作。`

export const RETRY_TEXT = (id: number): string =>
  `【superagent 奏折 #${id} 重试】用户要你再试一次。从上次停下的地方继续；上次卡住的那一步如果涉及权限，这次权限请求会由用户在本会话里处理。`
