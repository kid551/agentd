import { AgentdClient } from './client.js'
import { runHook, type HookEvent, type HookInput } from './permission.js'

// A Worker's permission hook: `node agentd-hook.mjs denied|request|pre`, the
// hook input on stdin, the decision (if any) on stdout. It knows its ticket from
// AGENTD_TICKET and finds the daemon at AGENTD_URL, both in the hook command the
// daemon wrote (permission.ts workerSettings). Any failure prints nothing, which
// leaves Claude Code's own decision standing.

const event = process.argv[2] as HookEvent
const ticket = Number(process.env.AGENTD_TICKET)
const baseUrl = process.env.AGENTD_URL ?? 'http://127.0.0.1:7707'

async function main(): Promise<void> {
  if (!['denied', 'request', 'pre'].includes(event) || !Number.isInteger(ticket) || ticket <= 0)
    return
  let raw = ''
  for await (const chunk of process.stdin) raw += String(chunk)
  const input = JSON.parse(raw) as HookInput
  const output = await runHook(event, input, { client: new AgentdClient(baseUrl), ticket })
  if (output) process.stdout.write(JSON.stringify(output))
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`agentd-hook: ${String(error)}\n`)
    process.exit(0)
  },
)
