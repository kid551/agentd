// Copies the built single-file daemon, MCP server and permission hook into the
// router mod, so the mod finds them at `${$.plugin.root}/daemon/` in development
// and when shared.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, '..', 'dist')
const target = join(here, '..', '..', 'router-mod', 'daemon')
mkdirSync(target, { recursive: true })
for (const name of ['agentd.mjs', 'agentd-mcp.mjs', 'agentd-hook.mjs'])
  copyFileSync(join(dist, name), join(target, name))
console.log(`copied daemon to ${target}`)
