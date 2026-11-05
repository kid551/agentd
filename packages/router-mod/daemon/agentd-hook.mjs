#!/usr/bin/env node
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
// src/permission.ts
const APPROVE = "批准";
const REJECT = "拒绝";
const YES = /* @__PURE__ */ new Set([
	"批准",
	"准奏",
	"准",
	"同意",
	"允许",
	"可以",
	"好",
	"行",
	"yes",
	"y",
	"ok",
	"approve",
	"allow"
]);
/**
* Only a plain yes approves: a reply that says anything else is a no, so a
* misread answer never runs what the classifier refused.
*/
function isApproval(answer) {
	const flat = answer.trim().toLowerCase().replace(/[\s。.!！~～]+$/u, "");
	if (YES.has(flat)) return true;
	return /^(批准|准奏)[\s，,。.!！；;：:]/u.test(flat);
}
const stable = (value) => {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
	return value;
};
/**
* Names one tool call. `description` is left out: the model rewrites a Bash
* call's description freely, and it changes nothing the call does.
*/
function grantKey(toolName, toolInput) {
	const input = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? Object.fromEntries(Object.entries(toolInput).filter(([k]) => k !== "description")) : toolInput;
	return `${toolName} ${JSON.stringify(stable(input))}`;
}
const clip = (text, limit) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
/** What the call would do, in the words a person checks before approving. */
function callText(toolName, toolInput) {
	const input = toolInput ?? {};
	const pick = (key) => typeof input[key] === "string" ? input[key] : null;
	const body = pick("command") ?? pick("file_path") ?? pick("url") ?? pick("path") ?? JSON.stringify(toolInput ?? {}, null, 2);
	return `\`\`\`\n${clip(body, 1500)}\n\`\`\``;
}
function permissionQuestion(event, input) {
	const tool = input.tool_name ?? "未知工具";
	const lines = [`**权限请求**：Worker 想用 \`${tool}\` 做这件事——`, callText(tool, input.tool_input)];
	if (event === "denied" && input.reason) lines.push(`自动审查拒绝了它，理由：${clip(input.reason.trim(), 300)}`);
	if (typeof input.tool_input?.description === "string") lines.push(`Worker 的说明：${clip(input.tool_input.description, 200)}`);
	lines.push("批准这一次吗？");
	return lines.join("\n\n");
}
/** Asks the person and waits; null when the question could not be asked or was withdrawn. */
async function askPerson(deps, event, input) {
	const tool = input.tool_name ?? "";
	let qid;
	try {
		const asked = await deps.client.post(`/tickets/${deps.ticket}/ask`, {
			question: permissionQuestion(event, input),
			options: [APPROVE, REJECT],
			kind: "permission",
			...event === "denied" ? { grantKey: grantKey(tool, input.tool_input) } : {}
		});
		if (!asked.data.ok || asked.data.questionId === void 0) return null;
		qid = asked.data.questionId;
	} catch {
		return null;
	}
	for (;;) try {
		const r = await deps.client.get(`/questions/${qid}?wait=${deps.waitSeconds ?? 25}`);
		if (r.data.answered) return r.data.answer ?? "";
		if (r.data.withdrawn) return null;
	} catch {
		await new Promise((resolve) => setTimeout(resolve, deps.retryMs ?? 3e3));
	}
}
/** One hook run: what to print on stdout, or null to print nothing and change nothing. */
async function runHook(event, input, deps) {
	if (event === "pre") {
		try {
			if (!(await deps.client.post(`/tickets/${deps.ticket}/grants/take`, { key: grantKey(input.tool_name ?? "", input.tool_input) })).data.granted) return null;
		} catch {
			return null;
		}
		return { hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "allow",
			permissionDecisionReason: "用户已在 Router 批准这一次"
		} };
	}
	const answer = await askPerson(deps, event, input);
	const approved = answer !== null && isApproval(answer);
	if (event === "denied") return approved ? { hookSpecificOutput: {
		hookEventName: "PermissionDenied",
		retry: true
	} } : null;
	const message = answer === null ? "agentd 没能把这个权限请求转给用户（或已撤回）。" : `用户没有批准：${answer}`;
	return { hookSpecificOutput: {
		hookEventName: "PermissionRequest",
		decision: approved ? { behavior: "allow" } : {
			behavior: "deny",
			message
		}
	} };
}
// src/hook.ts
const event = process.argv[2];
const ticket = Number(process.env.AGENTD_TICKET);
const baseUrl = process.env.AGENTD_URL ?? "http://127.0.0.1:7707";
async function main() {
	if (![
		"denied",
		"request",
		"pre"
	].includes(event) || !Number.isInteger(ticket) || ticket <= 0) return;
	let raw = "";
	for await (const chunk of process.stdin) raw += String(chunk);
	const input = JSON.parse(raw);
	const output = await runHook(event, input, {
		client: new AgentdClient(baseUrl),
		ticket
	});
	if (output) process.stdout.write(JSON.stringify(output));
}
main().then(() => process.exit(0), (error) => {
	process.stderr.write(`agentd-hook: ${String(error)}\n`);
	process.exit(0);
});
export {};
