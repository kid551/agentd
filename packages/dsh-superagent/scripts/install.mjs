// Installs the built plugin into a dsh profile, or removes it (--remove).
//
//   pnpm --filter dsh-superagent install:dsh      # build first
//   pnpm --filter dsh-superagent uninstall:dsh
//
// Copies dist/ into <profile>/plugins/dsh-superagent/ (copies, not a symlink:
// dsh resolves a profile plugin's own imports from where it sits) and keeps one
// marked block in <profile>/cordis.patch.yml that inserts the Router preset and
// the plugin row. The patch file is backed up before every change. dsh watches
// the patch file and recomposes without a restart.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, '..', 'dist')
const profile = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop')
const target = join(profile, 'plugins', 'dsh-superagent')
const patchFile = join(profile, 'cordis.patch.yml')

const BEGIN = '# >>> dsh-superagent (managed by agentd/packages/dsh-superagent/scripts/install.mjs)'
const END = '# <<< dsh-superagent'

/**
 * The managed block. `build` names the installed build: dsh recomposes only
 * when the patch file's content changes, so a new build must change it.
 */
export const block = build => `${BEGIN}
# build ${build}
# Super-agent: the Router preset (no execution tools; the plugin adds the
# routing tools to the Router session) and the host plugin. Remove with
# \`pnpm --filter dsh-superagent uninstall:dsh\`.
- insert:
    - id: preset-superagent-router
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: superagent-router
        order: 90
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You are the Router of a Super-agent, powered by the {{model}} model.
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
    - id: superagent
      name: ./plugins/dsh-superagent/index.js
      config:
        roots:
          - ~/code
          - ~/project
        maxConcurrent: 4
        workerPreset: standard
${END}
`

const MANIFEST = {
  name: 'dsh-superagent',
  version: '0.1.0',
  private: true,
  type: 'module',
  main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' },
  dsh: {
    client: {
      platform: 'web',
      inject: ['@deepseek-ai/dsh-client-ui-workspace'],
    },
  },
}

/** The patch text with the managed block replaced (or dropped when `block` is empty). */
export function withBlock(text, block) {
  const start = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  let rest = text
  if (start >= 0 && end > start)
    rest = text.slice(0, start) + text.slice(end + END.length).replace(/^\n/, '')
  rest = rest.replace(/\n*$/, '\n')
  return block === '' ? rest : `${rest}\n${block}`
}

function backup() {
  if (!existsSync(patchFile)) return
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
  copyFileSync(patchFile, `${patchFile}.bak-superagent-${stamp}`)
}

function main() {
  const remove = process.argv.includes('--remove')
  if (!existsSync(profile)) throw new Error(`没有 dsh profile：${profile}`)
  const current = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '[]\n'
  if (remove) {
    backup()
    const next = withBlock(current, '')
    // A patch file that parses to nothing throws in dsh; keep it a list.
    writeFileSync(patchFile, /^\s*(#.*\n|\s)*$/.test(next) ? `${next}[]\n` : next)
    rmSync(target, { recursive: true, force: true })
    console.log(`已移除：${target} 与 ${patchFile} 中的 dsh-superagent 段`)
    return
  }
  for (const file of ['index.js', 'client.js']) {
    if (!existsSync(join(dist, file)))
      throw new Error(`缺少 dist/${file}，先运行 pnpm --filter dsh-superagent build`)
  }
  mkdirSync(target, { recursive: true })
  for (const file of ['index.js', 'client.js']) copyFileSync(join(dist, file), join(target, file))
  writeFileSync(join(target, 'package.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`)
  backup()
  // `[]` alone means "no patches"; a block needs a list document instead.
  const base = current.trim() === '[]' ? '' : current
  const build = createHash('sha256')
    .update(readFileSync(join(dist, 'index.js')))
    .update(readFileSync(join(dist, 'client.js')))
    .digest('hex')
    .slice(0, 12)
  writeFileSync(patchFile, withBlock(base, block(build)))
  console.log(`已安装构建 ${build} 到 ${target}，并更新 ${patchFile}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
