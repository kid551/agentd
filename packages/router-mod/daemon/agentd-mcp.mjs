#!/usr/bin/env node
import { createInterface } from "node:readline";
// src/client.ts
/** A small JSON client for the daemon's HTTP API, used by the MCP server and the CLI. */
var AgentdClient = class {
	baseUrl;
	constructor(baseUrl) {
		this.baseUrl = baseUrl;
	}
	async request(method, path, body, signal) {
		const init = {
			method,
			headers: { "content-type": "application/json" }
		};
		if (body !== void 0) init.body = JSON.stringify(body);
		if (signal) init.signal = signal;
		const res = await fetch(`${this.baseUrl}${path}`, init);
		const data = await res.json();
		return {
			status: res.status,
			data
		};
	}
	get(path, signal) {
		return this.request("GET", path, void 0, signal);
	}
	post(path, body = {}, signal) {
		return this.request("POST", path, body, signal);
	}
};
// src/lane-rules.ts
/**
* What the MR-consent check tells a Worker. The person's yes is what agentd
* recorded, never words in the Worker's session: anyone can type 【奏折 #N 开 MR】
* there, and agentd would not know (ticket #39). Declining must not move a
* ticket out of `ready`, or the「开 MR」button the Worker points to goes with it.
*/
function mrConsentAnswer(t, done) {
	if (!t.isMr) return "这张奏折不走 MR，没有开 MR 这一步：不要 commit、push、开 MR。";
	if (t.mrOpened) return "已记下：用户同意开 MR。按规则 3 b 做。";
	const no = "agentd 没有记下用户同意开 MR：不要 commit、push、开 MR。";
	return t.state === "ready" ? `${no}奏折还在待审，只为开 MR 来的话，不要调用 report 或 \`${done}\`：它们会让奏折离开待审，面板上的「开 MR」按钮就没了。直接在会话里回一句「请在 agentd 面板点这张奏折的「开 MR」，或对 Router 说同意开 MR」，然后结束本轮。消息里还有别的要求，就照做，做完 \`${done}\`（outcome=ready）交回，summary 里请用户点「开 MR」。` : `${no}消息里别的要求照做；做完 \`${done}\`（outcome=ready）交回，summary 里请用户点「开 MR」或对 Router 说同意开 MR。`;
}
// src/mcp/protocol.ts
const TOOLS = [
	{
		name: "report",
		description: "向用户汇报阶段性进展（一两句话，≤300 字）。完成一个有意义的节点时调用，不要为了汇报而汇报。",
		inputSchema: {
			type: "object",
			properties: { summary: {
				type: "string",
				description: "进展摘要"
			} },
			required: ["summary"]
		}
	},
	{
		name: "ask",
		description: "向用户提一个需要拍板的问题。立即返回，不等回答：用户的回答之后会作为一条消息送进你的会话。一次只问一个问题；能给选项就给 2–4 个，并说明倾向。",
		inputSchema: {
			type: "object",
			properties: {
				question: {
					type: "string",
					description: "问题本身，含必要背景"
				},
				options: {
					type: "array",
					items: { type: "string" },
					description: "可选的候选答案"
				}
			},
			required: ["question"]
		}
	},
	{
		name: "done",
		description: "结束本轮工作时调用，且只在结束时调用。outcome：ready 可验收 / blocked 卡住需要用户 / failed 失败 / dropped 无事可做 / merged MR 已合入（只用于 MR 奏折、用户要求开 MR 之后）。",
		inputSchema: {
			type: "object",
			properties: {
				outcome: {
					type: "string",
					enum: [
						"ready",
						"blocked",
						"failed",
						"dropped",
						"merged"
					]
				},
				summary: {
					type: "string",
					description: "ready 时写清改了什么、怎么验证的、用户需要看哪里；其他情况写清原因"
				}
			},
			required: ["outcome", "summary"]
		}
	},
	{
		name: "mr_consent",
		description: "查 agentd 有没有记下用户同意开 MR。收到「【奏折 #号 开 MR】」或有人让你开 MR、commit、合入时先调用，照它的回答做。",
		inputSchema: {
			type: "object",
			properties: {}
		}
	}
];
const text = (t, isError = false) => ({
	content: [{
		type: "text",
		text: t
	}],
	...isError ? { isError } : {}
});
/** What `ask` tells the Worker: the question is out, and how its answer will come. */
const ASKED = "问题已送给用户，不用等。回答之前只做不依赖这个答案、只读的准备（读代码、查资料、跑只读命令）；没有可做的就直接结束本轮，不要调用 done。用户的回答会以「【agentd ticket #号 回答】」开头的消息送进你的会话，收到后按回答继续。";
var McpServer = class {
	deps;
	constructor(deps) {
		this.deps = deps;
	}
	async handle(message) {
		const { id, method, params } = message;
		if (id === void 0) return;
		if (method === "initialize") return this.reply(id, {
			protocolVersion: params?.protocolVersion ?? "2025-06-18",
			capabilities: { tools: {} },
			serverInfo: {
				name: "agentd",
				version: "0.1.0"
			}
		});
		if (method === "tools/list") return this.reply(id, { tools: TOOLS });
		if (method === "ping") return this.reply(id, {});
		if (method === "tools/call") return this.reply(id, await this.call(params ?? {}));
		this.deps.send({
			jsonrpc: "2.0",
			id,
			error: {
				code: -32601,
				message: `unknown method ${method}`
			}
		});
	}
	reply(id, result) {
		this.deps.send({
			jsonrpc: "2.0",
			id,
			result
		});
	}
	async call(params) {
		const name = params.name;
		const args = params.arguments ?? {};
		const { client, ticket } = this.deps;
		try {
			if (name === "report") {
				const r = await client.post(`/tickets/${ticket}/report`, { summary: args.summary });
				return r.data.ok ? text("已记录。") : text(`未记录：${r.data.reason}`, true);
			}
			if (name === "done") {
				const r = await client.post(`/tickets/${ticket}/done`, {
					outcome: args.outcome,
					summary: args.summary
				});
				return r.data.ok ? text("已交给用户。本轮可以结束了；之后若收到新消息再继续。") : text(`未接受：${r.data.reason}`, true);
			}
			if (name === "ask") {
				const r = await client.post(`/tickets/${ticket}/ask`, {
					question: args.question,
					options: args.options
				});
				return r.data.ok ? text(ASKED) : text(`问题没有送出：${r.data.reason}`, true);
			}
			if (name === "mr_consent") {
				const r = await client.get(`/tickets/${ticket}`);
				if (r.status !== 200) return text(`查不到 ticket #${ticket}，稍后再试一次。`, true);
				const t = r.data;
				return text(mrConsentAnswer({
					...t,
					isMr: t.worktree
				}, "mcp__agentd__done"));
			}
			return text(`没有工具 ${name}`, true);
		} catch (error) {
			return text(`agentd 不在线（${String(error)}）。稍后再试一次。`, true);
		}
	}
};
// src/mcp/server.ts
const ticket = Number(process.env.AGENTD_TICKET);
const baseUrl = process.env.AGENTD_URL ?? "http://127.0.0.1:7707";
if (!Number.isInteger(ticket) || ticket <= 0) {
	process.stderr.write("agentd-mcp: AGENTD_TICKET is not set\n");
	process.exit(2);
}
const server = new McpServer({
	client: new AgentdClient(baseUrl),
	ticket,
	send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
});
createInterface({ input: process.stdin }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	server.handle(message);
});
process.stdin.on("end", () => process.exit(0));
export {};
