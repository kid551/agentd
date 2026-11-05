import { createInterface } from 'node:readline'

import { AgentdClient } from '../client.js'
import { McpServer, type JsonRpc } from './protocol.js'

// The Worker's MCP server: stdio JSON-RPC, one line per message. Started by
// Claude Code from the per-ticket config the daemon writes; it knows its ticket
// from AGENTD_TICKET and finds the daemon at AGENTD_URL.

const ticket = Number(process.env.AGENTD_TICKET)
const baseUrl = process.env.AGENTD_URL ?? 'http://127.0.0.1:7707'
if (!Number.isInteger(ticket) || ticket <= 0) {
  process.stderr.write('agentd-mcp: AGENTD_TICKET is not set\n')
  process.exit(2)
}

const server = new McpServer({
  client: new AgentdClient(baseUrl),
  ticket,
  send: message => process.stdout.write(`${JSON.stringify(message)}\n`),
})

createInterface({ input: process.stdin }).on('line', line => {
  let message: JsonRpc
  try {
    message = JSON.parse(line) as JsonRpc
  } catch {
    return
  }
  void server.handle(message)
})

// Claude Code closes stdin when the Worker session ends; leave with it.
process.stdin.on('end', () => process.exit(0))
