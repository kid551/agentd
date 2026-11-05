// Prepares the Router workspace: router/.claude/settings.json names this
// repository as a local plugin marketplace and turns agentd-router on for
// that folder alone. The file holds this machine's absolute path, so it is
// written here rather than committed.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const router = join(repo, 'router')
const file = join(router, '.claude', 'settings.json')

if (!existsSync(join(repo, 'packages', 'router-mod', 'daemon', 'agentd.mjs'))) {
  console.error('先运行 pnpm build：router-mod/daemon/ 里还没有守护进程。')
  process.exit(1)
}

const MARKET = 'TerenceXie-agentd'
const PLUGIN = `agentd-router@${MARKET}`
// Names this script registered before the marketplace was renamed. Left in
// place beside the new ones, the plugin would load twice and every hook fire
// twice, so they go first. Removing the marketplace uninstalls its plugin.
const OLD_MARKET = 'agentd'
const claude = (args, cwd, stdio = 'inherit') => execFileSync('claude', args, { cwd, stdio })
try {
  claude(['plugin', 'marketplace', 'remove', OLD_MARKET], repo, 'pipe')
  console.log(`removed the old marketplace ${OLD_MARKET}`)
} catch {
  // Not registered: nothing to migrate.
}

const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
const { [OLD_MARKET]: _oldMarket, ...markets } = current.extraKnownMarketplaces ?? {}
const { [`agentd-router@${OLD_MARKET}`]: _oldPlugin, ...plugins } = current.enabledPlugins ?? {}
const settings = {
  ...current,
  model: current.model ?? 'sonnet',
  extraKnownMarketplaces: { ...markets, [MARKET]: { source: { source: 'directory', path: repo } } },
  enabledPlugins: { ...plugins, [PLUGIN]: true },
}
mkdirSync(dirname(file), { recursive: true })
writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
console.log(`wrote ${file}`)

// A marketplace named only in project settings is skipped as unregistered, so
// register this folder as one (user level), then install the plugin for the
// Router folder alone. The plugin is read from packages/router-mod directly:
// an edit there takes effect on /reload-plugins.
claude(['plugin', 'marketplace', 'add', repo], repo)
claude(['plugin', 'install', PLUGIN, '--scope', 'project'], router)
console.log(
  `下一步：code ${router}，在其中打开 Claude Code。第一次会问是否信任该目录与 ${MARKET} marketplace，选是。已开着的 Router 窗口重开或 /reload-plugins。`,
)
