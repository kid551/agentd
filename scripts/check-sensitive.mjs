#!/usr/bin/env node
// Refuses private material in this public repository. See AGENTS.md.
//
//   node scripts/check-sensitive.mjs            every tracked file
//   node scripts/check-sensitive.mjs --staged   what is about to be committed, and who commits it
//   node scripts/check-sensitive.mjs --message <file>   a commit message (the commit-msg hook)
//
// The rules here are generic on purpose: a list of the owner's own words would itself leak
// them. Personal words (company, hosts, private project names) go one per line in
// `.sensitive-words` at the repository root, which is ignored by git. A line holding
// `sensitive-check: allow` is skipped.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ALLOW_MARK = 'sensitive-check: allow'

/** Names that only ever stand in for someone: `/Users/alice`, `alice@example.com`. */
const PLACEHOLDER_USERS = new Set([
  'alice',
  'bob',
  'me',
  'you',
  'user',
  'name',
  'runner',
  'example',
])

/** Hosts a public example may name. Anything else in a git remote is someone's server. */
const PUBLIC_HOSTS = new Set(['github.com', 'ssh.github.com', 'gitlab.com', 'bitbucket.org'])

const isExampleHost = host => /(^|\.)example(\.(com|org|net))?$/.test(host) || host === 'localhost'

const isPublicEmail = email => {
  const domain = email.split('@')[1].toLowerCase()
  return (
    isExampleHost(domain) ||
    domain === 'users.noreply.github.com' ||
    domain.endsWith('.users.noreply.github.com') ||
    email.toLowerCase() === 'noreply@anthropic.com' ||
    email.toLowerCase() === 'noreply@github.com'
  )
}

/** Files that hold private notes, keys or data whatever their content. */
export function badFileName(path) {
  const name = basename(path)
  if (/^\.env(\..+)?$/.test(name) && name !== '.env.example') return 'environment file'
  if (/\.(pem|key|p12|pfx|keystore|jks)$/i.test(name) || /^id_(rsa|ed25519|ecdsa|dsa)/.test(name))
    return 'key file'
  if (/\.(db|sqlite3?)(-wal|-shm)?$/i.test(name)) return 'database file'
  if (name === 'implementation-notes.md' || name === 'history_record.md') return 'private notes'
  if (name === '.sensitive-words') return 'the private word list itself'
  return null
}

const SECRET_PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Anthropic / OpenAI key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{16,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./],
  [
    'secret assigned a literal',
    /\b(api[_-]?key|secret|token|passw(or)?d)\b["']?\s*[:=]\s*["'][^"'\s$<{]{12,}["']/i,
  ],
]

/** Every problem on one line of text, as short reasons. */
export function lineProblems(line, words = []) {
  if (line.includes(ALLOW_MARK)) return []
  const found = []
  for (const [what, re] of SECRET_PATTERNS) if (re.test(line)) found.push(what)

  for (const m of line.matchAll(
    /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]+Users[\\/]+)([A-Za-z0-9._-]+)/g,
  ))
    if (m[1].length > 1 && !PLACEHOLDER_USERS.has(m[1].toLowerCase()) && m[1] !== 'Shared')
      found.push(`home path of "${m[1]}"`)

  for (const m of line.matchAll(/(?<![\w.%+-])[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g)) {
    const email = m[0]
    if (/^git@/i.test(email)) continue // the ssh user of a remote, checked as a host below
    if (!isPublicEmail(email)) found.push(`email ${email}`)
  }

  for (const m of line.matchAll(/(?:git@|ssh:\/\/(?:[\w.-]+@)?)([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
    const host = m[1].toLowerCase()
    if (!PUBLIC_HOSTS.has(host) && !isExampleHost(host)) found.push(`git host ${host}`)
  }

  if (/\b[a-z0-9-]+\.ts\.net\b/i.test(line)) found.push('Tailscale host')
  if (/\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/.test(line))
    found.push('private IP address')

  const lower = line.toLowerCase()
  for (const w of words) if (lower.includes(w)) found.push(`private word "${w}"`)
  return found
}

/** Problems in one file's text, one entry per hit. */
export function textProblems(path, text, words = []) {
  const out = []
  const bad = badFileName(path)
  if (bad) out.push({ path, line: 0, why: bad })
  text.split('\n').forEach((line, i) => {
    for (const why of lineProblems(line, words)) out.push({ path, line: i + 1, why })
  })
  return out
}

/** The committer's address must not be a personal one: it is published with every commit. */
export function identityProblem(email) {
  if (!email) return 'git user.email is not set'
  return isPublicEmail(email)
    ? null
    : `git user.email is ${email}; use your GitHub noreply address (see AGENTS.md)`
}

export function readWords(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .map(w => w.trim().toLowerCase())
    .filter(w => w && !w.startsWith('#'))
}

const SKIP = new Set(['pnpm-lock.yaml'])

/** Comment lines git strips from a commit message, and the diff `commit -v` appends. */
export function messageText(raw) {
  const cut = raw.indexOf('# ------------------------ >8 ------------------------')
  return (cut === -1 ? raw : raw.slice(0, cut))
    .split('\n')
    .filter(l => !l.startsWith('#'))
    .join('\n')
}

function main() {
  const argv = process.argv.slice(2)
  const staged = argv.includes('--staged')
  const messageAt = argv.indexOf('--message')
  const messageFile = messageAt === -1 ? null : resolve(argv[messageAt + 1] ?? '')
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 })
  const root = git('rev-parse', '--show-toplevel').trim()
  // A worktree (agentd's Workers commit from one) has no copy of the word list: read the
  // main checkout's too.
  const common = dirname(resolve(root, git('rev-parse', '--git-common-dir').trim()))
  process.chdir(root)
  const words = [
    ...new Set([...readWords('.sensitive-words'), ...readWords(join(common, '.sensitive-words'))]),
  ]

  if (messageFile) {
    const problems = textProblems(
      '(commit message)',
      messageText(readFileSync(messageFile, 'utf8')),
      words,
    )
    report(problems, words)
    return
  }

  const files = staged
    ? git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0')
    : git('ls-files', '-z').split('\0')
  const problems = []
  for (const path of files.filter(f => f && !SKIP.has(f))) {
    let text
    try {
      text = staged ? git('show', `:${path}`) : readFileSync(path, 'utf8')
    } catch {
      continue // deleted in the work tree, or a submodule
    }
    if (text.includes('\0')) {
      const bad = badFileName(path)
      if (bad) problems.push({ path, line: 0, why: bad })
      continue
    }
    problems.push(...textProblems(path, text, words))
  }
  if (staged) {
    // GIT_AUTHOR_IDENT, not user.email: it also sees GIT_AUTHOR_EMAIL set in the environment.
    for (const role of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      let email = ''
      try {
        email = /<([^>]*)>/.exec(git('var', role))?.[1] ?? ''
      } catch {
        // unset: git refuses to commit anyway
      }
      const who = identityProblem(email)
      if (who) problems.push({ path: `(${role})`, line: 0, why: who })
    }
  }
  report(problems, words)
}

function report(problems, words) {
  if (problems.length === 0) {
    console.log(`check-sensitive: ok (${words.length} private words loaded)`)
    return
  }
  for (const p of problems) console.error(`${p.path}${p.line ? `:${p.line}` : ''}  ${p.why}`)
  console.error(
    `\ncheck-sensitive: ${problems.length} problem(s). This repository is public; see AGENTS.md.\n` +
      `Use placeholders (acme, alice, example.com, ~/code). A deliberate exception takes a\n` +
      `"${ALLOW_MARK}" comment on the same line.`,
  )
  process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
