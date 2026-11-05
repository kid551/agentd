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
        },
        ['title', 'task', 'project'],
      ),
      args =>
        service.dispatch({
          title: args.title as string,
          task: args.task as string,
          project: args.project as string,
          readonly: args.readonly === true,
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
      '列出奏折。默认只列进行中和 24 小时内结束的。',
      object({ scope: { type: 'string', enum: ['live', 'all'], description: 'live 或 all' } }, []),
      async args => {
        const tickets = service.list(args.scope === 'all' ? 'all' : 'live')
        if (tickets.length === 0) return { ok: true, text: '没有奏折。' }
        return {
          ok: true,
          text: tickets
            .map(
              t =>
                `${header(t)}（${phaseWord(t)}${t.readonly === true ? ' · 只读' : t.worktree ? ' · MR' : ''}）${t.lastReport ? ` · ${t.lastReport.slice(0, 120)}` : ''}`,
            )
            .join('\n'),
        }
      },
    ),
    tool(
      'superagent_read',
      '读一张奏折的细节。depth：summary（任务与最近消息）→ events（事件全文）→ transcript（Worker 会话尾部）。',
      object(
        {
          ...ID,
          depth: {
            type: 'string',
            enum: ['summary', 'events', 'transcript'],
            description: '读多深',
          },
        },
        ['id'],
      ),
      args =>
        service.read(
          args.id as number,
          (args.depth as 'summary' | 'events' | 'transcript' | undefined) ?? 'summary',
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
