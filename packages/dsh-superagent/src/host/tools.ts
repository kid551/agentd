import { phaseWord } from '../core/state.js'
import { header } from '../core/text.js'
import type { Outcome } from '../core/types.js'
import type { Result, SuperAgentService } from './service.js'

// Tools in the shape `defineTool` from @deepseek-ai/dsh-tools produces: JSON
// Schema parameters, an output schema with a renderer, and `execute`. They are
// written out by hand because a profile plugin cannot import the installed dsh
// packages reliably (the profile's module fallback may point at another copy).

type Schema = Record<string, unknown>
type Exec = { agent?: { id: string }; signal?: AbortSignal }
type Args = Record<string, unknown>

export type ToolDefinition = {
  name: string
  description: string
  parameters: Schema
  output: {
    schema: Schema
    render(args: Args, value: { text: string }): { type: 'text'; text: string }[]
  }
  execute(args: Args, exec: Exec): Promise<{ text: string }>
}

const OUTPUT: ToolDefinition['output'] = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', description: 'Result for the model.' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

const str = (description: string): Schema => ({ type: 'string', description })
const int = (description: string): Schema => ({ type: 'integer', description })

function object(properties: Record<string, Schema>, required: string[]): Schema {
  return { type: 'object', properties, required, additionalProperties: false }
}

/** Checks what the schema says, so a malformed call fails with a reason the model can act on. */
export function checkArgs(schema: Schema, args: Args): string | undefined {
  const props = (schema.properties ?? {}) as Record<string, Schema>
  for (const key of (schema.required ?? []) as string[]) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return `缺少参数 ${key}`
  }
  for (const [key, value] of Object.entries(args)) {
    const want = props[key]
    if (want === undefined) return `未知参数 ${key}`
    if (want.type === 'integer' && !Number.isInteger(value)) return `${key} 必须是整数`
    if (want.type === 'string' && typeof value !== 'string') return `${key} 必须是字符串`
    if (want.type === 'boolean' && typeof value !== 'boolean') return `${key} 必须是布尔值`
    if (Array.isArray(want.enum) && !want.enum.includes(value))
      return `${key} 只能是 ${want.enum.join(' / ')}`
  }
  return undefined
}

function tool(
  name: string,
  description: string,
  parameters: Schema,
  run: (args: Args, exec: Exec) => Promise<Result>,
): ToolDefinition {
  return {
    name,
    description,
    parameters,
    output: OUTPUT,
    async execute(args, exec) {
      const problem = checkArgs(parameters, args)
      if (problem !== undefined) throw new Error(problem)
      const result = await run(args, exec)
      if (!result.ok) throw new Error(result.text)
      return { text: result.text }
    },
  }
}

const ID = { id: int('奏折号（#后面的数字）') }

/** 「 · 11月3日结束」for an ended ticket in a list; empty for a live one. */
const endedDay = (at: number | undefined): string => {
  if (at === undefined) return ''
  const day = new Date(at)
  return ` · ${day.getMonth() + 1}月${day.getDate()}日结束`
}

export function routerTools(service: SuperAgentService): ToolDefinition[] {
  return [
    tool(
      'superagent_dispatch',
      '开一张奏折：在某个项目目录里起一个 Worker 会话去做一件事。MR 项目里写代码的奏折会自动得到自己的 worktree，同项目可以并行。',
      object(
        {
          title: str('不超过 30 字的中文概括'),
          task: str('Worker 能独立执行的完整任务描述，保留用户原话里的约束'),
          project: str('项目名、项目 id 或绝对路径'),
          readonly: {
            type: 'boolean',
            description: '只查看、分析、回答问题，不改任何东西时设 true',
          },
          follows: int(
            '这件事接着一张旧奏折做时填它的号（先用 superagent_list 找到）。两张奏折的 superagent_read 会互相链到对方',
          ),
        },
        ['title', 'task', 'project'],
      ),
      args =>
        service.dispatch({
          title: args.title as string,
          task: args.task as string,
          project: args.project as string,
          readonly: args.readonly === true,
          ...(typeof args.follows === 'number' ? { follows: args.follows } : {}),
        }),
    ),
    tool(
      'superagent_message',
      '把用户的追加指令转给某张奏折的 Worker。用户同意开 MR 不用它，用 superagent_open_mr。',
      object({ ...ID, text: str('要转达的话') }, ['id', 'text']),
      args => service.message(args.id as number, args.text as string),
    ),
    tool(
      'superagent_close',
      '验收并收掉一张奏折（用户说「收了」时）。还没合入的 MR 奏折收 = 放弃改动、删掉它的 worktree 和分支：先跟用户确认，确认后带 discard=true。',
      object(
        {
          ...ID,
          discard: { type: 'boolean', description: '用户确认放弃 MR 奏折的改动' },
        },
        ['id'],
      ),
      args => service.close(args.id as number, args.discard === true),
    ),
    tool(
      'superagent_open_mr',
      'MR 奏折待审（ready）时，用户审过交付、同意开 MR 后调用：Worker 接着 commit、push、开 MR、盯流水线到合入，合入后奏折自动结束并清理。用户同意时还交代了别的（例如先验证），写进 text 一起送到。',
      object({ ...ID, text: str('用户同意时附带的要求，没有就不填') }, ['id']),
      args => service.openMr(args.id as number, typeof args.text === 'string' ? args.text : ''),
    ),
    tool(
      'superagent_stop',
      '叫停一张奏折：中止 Worker 当前这一轮，会话保留。',
      object(ID, ['id']),
      args => service.stop(args.id as number),
    ),
    tool('superagent_retry', '让受阻或失败的奏折再试一次。', object(ID, ['id']), args =>
      service.retry(args.id as number),
    ),
    tool(
      'superagent_resume',
      '恢复已停或中断的奏折：Worker 先自查、汇报，再问下一步。',
      object(ID, ['id']),
      args => service.resume(args.id as number),
    ),
    tool(
      'superagent_list',
      '列出奏折。默认只列进行中和 24 小时内结束的。用户提起旧任务（「上次那个」「之前改登录的」）时带 query（匹配标题、任务原文、最近消息）和 / 或 project 查，已结束的也在内，最新的在前。',
      object(
        {
          scope: { type: 'string', enum: ['live', 'all'], description: 'live 或 all' },
          query: str('关键词，一两个词'),
          project: str('项目名的一部分'),
          limit: int('最多列几张，默认 20'),
        },
        [],
      ),
      async args => {
        const search = typeof args.query === 'string' || typeof args.project === 'string'
        const tickets = search
          ? service.find({
              query: args.query as string | undefined,
              project: args.project as string | undefined,
              limit: args.limit as number | undefined,
            })
          : service.list(args.scope === 'all' ? 'all' : 'live')
        if (tickets.length === 0)
          return {
            ok: true,
            text: search ? '没有找到。换个关键词，或去掉项目再找。' : '没有奏折。',
          }
        return {
          ok: true,
          text: tickets
            .map(
              t =>
                `${header(t)}（${phaseWord(t)}${t.readonly === true ? ' · 只读' : t.worktree ? ' · MR' : ''}${endedDay(t.endedAt)}）${t.follows === undefined ? '' : ` · 接续 #${t.follows}`}${t.lastReport ? ` · ${t.lastReport.slice(0, 120)}` : ''}`,
            )
            .join('\n'),
        }
      },
    ),
    tool(
      'superagent_read',
      '读一张奏折的细节（链式召回）。depth：summary（任务、最近消息，以及它接续的和接续它的奏折）→ task（任务原文全文）/ events（事件全文）→ transcript（Worker 会话）。结果被截断或还有更早的部分时，会写明下一次该带的参数（before、row），照着读。',
      object(
        {
          ...ID,
          depth: {
            type: 'string',
            enum: ['summary', 'task', 'events', 'transcript'],
            description: '读多深',
          },
          limit: int('events / transcript：一页几条'),
          before: int('events / transcript：读这个位置之前的一页'),
          row: int('transcript：读被截断的这一条全文'),
        },
        ['id'],
      ),
      args =>
        service.read(
          args.id as number,
          (args.depth as 'summary' | 'task' | 'events' | 'transcript' | undefined) ?? 'summary',
          {
            ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
            ...(typeof args.before === 'number' ? { before: args.before } : {}),
            ...(typeof args.row === 'number' ? { row: args.row } : {}),
          },
        ),
    ),
    tool(
      'superagent_projects',
      '列出可以派工的项目，或按名字查找。',
      object({ query: str('可选：项目名的一部分') }, []),
      async args => {
        const q = typeof args.query === 'string' ? args.query.toLowerCase() : ''
        const found = service.projects().filter(p => q === '' || p.id.toLowerCase().includes(q))
        return {
          ok: true,
          text:
            found
              .slice(0, 80)
              .map(p => `${p.id} — ${p.path}`)
              .join('\n') || '没有匹配的项目。',
        }
      },
    ),
  ]
}

const sessionOf = (exec: Exec): string => {
  if (exec.agent === undefined) throw new Error('需要在 Worker 会话里调用')
  return exec.agent.id
}

export function workerTools(service: SuperAgentService): ToolDefinition[] {
  return [
    tool(
      'superagent_report',
      '阶段性进展：完成一个有意义的节点时调一次，一两句话，不超过 300 字。',
      object({ text: str('进展') }, ['text']),
      (args, exec) => service.report(sessionOf(exec), args.text as string),
    ),
    tool(
      'superagent_mr_consent',
      '查有没有记下用户同意开 MR。收到「【奏折 #号 开 MR】」或有人让你开 MR、commit、合入时先调用，照它的回答做。',
      object({}, []),
      async (_args, exec) => service.mrConsent(sessionOf(exec)),
    ),
    tool(
      'superagent_done',
      '结束本轮工作时调用，且只在结束时调用。',
      object(
        {
          outcome: {
            type: 'string',
            enum: ['ready', 'blocked', 'failed', 'dropped', 'merged'],
            description: '结果；merged 只用于 MR 奏折、用户要求开 MR 之后',
          },
          summary: str(
            'ready：改了什么、怎么验证、看哪里；blocked：卡在哪、需要用户做什么；failed / dropped：原因与依据',
          ),
        },
        ['outcome', 'summary'],
      ),
      (args, exec) =>
        service.done(sessionOf(exec), args.outcome as Outcome, args.summary as string),
    ),
  ]
}
