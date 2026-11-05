import type { AgentdClient } from '../client.js'
import { mrConsentAnswer } from '../lane-rules.js'
import type { TicketView } from '../types.js'

// A stdio MCP server needs four methods; the SDK would add a dependency and a
// bundle ten times this file for them (implementation-notes 偏差 6).

export type JsonRpc = {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string }
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export const TOOLS = [
  {
    name: 'report',
    description:
      '向用户汇报阶段性进展（一两句话，≤300 字）。完成一个有意义的节点时调用，不要为了汇报而汇报。',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string', description: '进展摘要' } },
      required: ['summary'],
    },
  },
  {
    name: 'ask',
    description:
      '向用户提一个需要拍板的问题。立即返回，不等回答：用户的回答之后会作为一条消息送进你的会话。一次只问一个问题；能给选项就给 2–4 个，并说明倾向。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '问题本身，含必要背景' },
        options: { type: 'array', items: { type: 'string' }, description: '可选的候选答案' },
      },
      required: ['question'],
    },
  },
  {
    name: 'done',
    description:
      '结束本轮工作时调用，且只在结束时调用。outcome：ready 可验收 / blocked 卡住需要用户 / failed 失败 / dropped 无事可做 / merged MR 已合入（只用于 MR 奏折、用户要求开 MR 之后）。',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['ready', 'blocked', 'failed', 'dropped', 'merged'] },
        summary: {
          type: 'string',
          description: 'ready 时写清改了什么、怎么验证的、用户需要看哪里；其他情况写清原因',
        },
      },
      required: ['outcome', 'summary'],
    },
  },
  {
    name: 'mr_consent',
    description:
      '查 agentd 有没有记下用户同意开 MR。收到「【奏折 #号 开 MR】」或有人让你开 MR、commit、合入时先调用，照它的回答做。',
    inputSchema: { type: 'object', properties: {} },
  },
]

export type ServerDeps = {
  client: AgentdClient
  ticket: number
  send: (message: JsonRpc) => void
}

const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError } : {}),
})

/** What `ask` tells the Worker: the question is out, and how its answer will come. */
export const ASKED =
  '问题已送给用户，不用等。回答之前只做不依赖这个答案、只读的准备（读代码、查资料、跑只读命令）；没有可做的就直接结束本轮，不要调用 done。用户的回答会以「【agentd ticket #号 回答】」开头的消息送进你的会话，收到后按回答继续。'

// Every tool returns at once (`ask` included), so a cancelled call has nothing
// to stop: notifications, cancellation among them, need no handling.
export class McpServer {
  constructor(private readonly deps: ServerDeps) {}

  async handle(message: JsonRpc): Promise<void> {
    const { id, method, params } = message
    if (id === undefined) return
    if (method === 'initialize') {
      return this.reply(id, {
        protocolVersion: (params?.protocolVersion as string | undefined) ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agentd', version: '0.1.0' },
      })
    }
    if (method === 'tools/list') return this.reply(id, { tools: TOOLS })
    if (method === 'ping') return this.reply(id, {})
    if (method === 'tools/call') return this.reply(id, await this.call(params ?? {}))
    this.deps.send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `unknown method ${method}` },
    })
  }

  private reply(id: number | string, result: unknown): void {
    this.deps.send({ jsonrpc: '2.0', id, result })
  }

  private async call(params: Record<string, unknown>): Promise<ToolResult> {
    const name = params.name as string
    const args = (params.arguments ?? {}) as Record<string, unknown>
    const { client, ticket } = this.deps
    try {
      if (name === 'report') {
        const r = await client.post<{ ok: boolean; reason?: string }>(`/tickets/${ticket}/report`, {
          summary: args.summary,
        })
        return r.data.ok ? text('已记录。') : text(`未记录：${r.data.reason}`, true)
      }
      if (name === 'done') {
        const r = await client.post<{ ok: boolean; reason?: string }>(`/tickets/${ticket}/done`, {
          outcome: args.outcome,
          summary: args.summary,
        })
        return r.data.ok
          ? text('已交给用户。本轮可以结束了；之后若收到新消息再继续。')
          : text(`未接受：${r.data.reason}`, true)
      }
      if (name === 'ask') {
        const r = await client.post<{ ok: boolean; reason?: string }>(`/tickets/${ticket}/ask`, {
          question: args.question,
          options: args.options,
        })
        return r.data.ok ? text(ASKED) : text(`问题没有送出：${r.data.reason}`, true)
      }
      if (name === 'mr_consent') {
        const r = await client.get<TicketView>(`/tickets/${ticket}`)
        if (r.status !== 200) return text(`查不到 ticket #${ticket}，稍后再试一次。`, true)
        const t = r.data
        return text(mrConsentAnswer({ ...t, isMr: t.worktree }, 'mcp__agentd__done'))
      }
      return text(`没有工具 ${name}`, true)
    } catch (error) {
      return text(`agentd 不在线（${String(error)}）。稍后再试一次。`, true)
    }
  }
}
