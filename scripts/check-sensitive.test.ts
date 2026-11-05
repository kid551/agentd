import { describe, expect, it } from 'vitest'
import {
  badFileName,
  commitProblems,
  identityProblem,
  lineProblems,
  messageText,
  textProblems,
} from './check-sensitive.mjs'

// Fixtures are glued together at run time so that this file passes the check itself.
const j = (...parts: string[]) => parts.join('')

describe('check-sensitive', () => {
  it('finds token shapes and literal secrets', () => {
    expect(lineProblems(j('key = "sk-', 'a'.repeat(24), '"'))).toContain('Anthropic / OpenAI key')
    expect(lineProblems(j('ghp_', 'A'.repeat(30)))).toContain('GitHub token')
    expect(lineProblems(j('glpat-', 'x'.repeat(20)))).toContain('GitLab token')
    expect(lineProblems(j('-----BEGIN OPENSSH ', 'PRIVATE KEY-----'))).toContain('private key')
    expect(lineProblems(j('password: "', 'hunter2hunter2', '"'))).toContain(
      'secret assigned a literal',
    )
    expect(lineProblems('token: process.env.TOKEN')).toEqual([])
  })

  it('finds real home paths and lets placeholders through', () => {
    expect(lineProblems(j('/Users', '/jdoe/code'))).toEqual(['home path of "jdoe"'])
    expect(lineProblems(j('C:/Users', '/jdoe/x'))).toEqual(['home path of "jdoe"'])
    expect(lineProblems(j('/Users', '/alice/code /home/u /Users/Shared'))).toEqual([])
  })

  it('finds personal emails but not noreply, example or ssh users', () => {
    expect(lineProblems(j('mail jdoe', '@corp.io'))).toEqual([j('email jdoe', '@corp.io')])
    expect(lineProblems(j('1+me', '@users.noreply.github.com alice', '@example.com'))).toEqual([])
    expect(lineProblems(j('git', '@github.com:me/x.git'))).toEqual([])
  })

  it('finds private git hosts, tailnets and private IPs', () => {
    expect(lineProblems(j('git', '@git.corp.io:team/x.git'))).toEqual(['git host git.corp.io'])
    expect(lineProblems(j('ssh://git', '@gitlab.example.com:7003/acme/acme.git'))).toEqual([])
    expect(lineProblems(j('box.tail1234', '.ts.net'))).toContain('Tailscale host')
    expect(lineProblems(j('http://192', '.168.1.20:80'))).toEqual(['private IP address'])
    expect(lineProblems('http://127.0.0.1:7707')).toEqual([])
  })

  it('finds the private words, whatever their case', () => {
    expect(lineProblems('Deploy to Zephyr', ['zephyr'])).toEqual(['private word "zephyr"'])
    expect(lineProblems('Deploy to Zephyr', [])).toEqual([])
  })

  it('skips a line marked as a deliberate exception', () => {
    expect(lineProblems(j('jdoe', '@corp.io // sensitive-check: allow'))).toEqual([])
  })

  it('refuses private files by name', () => {
    expect(badFileName('.env')).toBe('environment file')
    expect(badFileName('a/.env.local')).toBe('environment file')
    expect(badFileName('.env.example')).toBeNull()
    expect(badFileName('implementation-notes.md')).toBe('private notes')
    expect(badFileName('keys/id_ed25519')).toBe('key file')
    expect(badFileName('data/agentd.db-wal')).toBe('database file')
    expect(badFileName('README.html')).toBeNull()
  })

  it('reports file and line', () => {
    expect(textProblems('a.ts', j('ok\nmail jdoe', '@corp.io'))).toEqual([
      { path: 'a.ts', line: 2, why: j('email jdoe', '@corp.io') },
    ])
  })

  it('wants a noreply committer address', () => {
    expect(identityProblem(j('1+me', '@users.noreply.github.com'))).toBeNull()
    expect(identityProblem(j('jdoe', '@gmail.com'))).toContain('noreply')
    expect(identityProblem('')).toContain('not set')
  })

  it('reads a commit message as git keeps it: no comments, no verbose diff', () => {
    const raw = j(
      'subject\n\nbody\n# Please enter the message\n',
      '# ------------------------ >8 ------------------------\n',
      '+ jdoe',
      '@corp.io\n',
    )
    expect(messageText(raw)).toBe('subject\n\nbody\n')
  })

  it('reads a commit made elsewhere: GitHub squash merges use the account email', () => {
    const noreply = j('1+me', '@users.noreply.github.com')
    const ok = {
      sha: 'abcdef0123',
      author: noreply,
      committer: j('noreply', '@github.com'),
      message: 'fix (#2)',
    }
    expect(commitProblems(ok)).toEqual([])
    expect(commitProblems({ ...ok, author: j('jdoe', '@gmail.com') })).toEqual([
      { path: '(commit abcdef0)', line: 0, why: j('author jdoe', '@gmail.com') },
    ])
    expect(commitProblems({ ...ok, message: 'deploy to Zephyr' }, ['zephyr'])).toEqual([
      { path: '(commit abcdef0)', line: 1, why: 'private word "zephyr"' },
    ])
  })
})
