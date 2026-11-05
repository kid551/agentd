// Builds the hand-off for someone who installs agentd-router without access to
// the GitHub repository: output/agentd-router.zip (the marketplace, committed
// files only) and the install guide beside it. output/ is git-ignored.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(repo, 'output')
const zip = join(out, 'agentd-router.zip')
const guide = 'agentd-router-install.html'
// What the marketplace needs: its manifest and the one plugin it lists.
const PATHS = ['.claude-plugin', 'packages/router-mod']

const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })

// git archive packs HEAD, so uncommitted edits (a fresh daemon/ build above
// all) would be left out without a word. Refuse instead.
const dirty = git(['status', '--porcelain', '--', ...PATHS]).trim()
if (dirty) {
  console.error(`这些文件有未提交的改动，打进包的会是旧版本。先提交再打包：\n${dirty}`)
  process.exit(1)
}

mkdirSync(out, { recursive: true })
git(['archive', '--format=zip', '-o', zip, 'HEAD', ...PATHS])
copyFileSync(join(repo, 'scripts', 'share', guide), join(out, guide))

const sha = git(['rev-parse', '--short', 'HEAD']).trim()
console.log(`已打包提交 ${sha}：\n  ${zip}\n  ${join(out, guide)}\n把这两个文件一起发给对方。`)
