import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { assignIds, resolveProject, scanRoots } from '../src/projects.js'

const repo = (path: string): void => {
  mkdirSync(join(path, '.git'), { recursive: true })
}

describe('scanRoots', () => {
  test('finds repositories, does not look inside one, and skips node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentd-scan-'))
    repo(join(root, 'Acme', 'acme'))
    repo(join(root, 'Acme', 'acme-flutter'))
    repo(join(root, 'Acme', 'acme', 'nested'))
    repo(join(root, 'tools', 'node_modules', 'pkg'))
    repo(join(root, 'solo'))
    const ids = scanRoots([root], 3).map(p => p.id)
    expect(ids).toEqual(['acme', 'acme-flutter', 'solo'])
  })

  test('respects the depth limit and a missing root', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentd-scan-'))
    repo(join(root, 'a', 'b', 'c', 'deep'))
    expect(scanRoots([root, join(root, 'missing')], 3)).toEqual([])
    expect(scanRoots([root], 4).map(p => p.id)).toEqual(['deep'])
  })

  test('a repository reached twice, through a link or overlapping roots, is listed once', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentd-scan-'))
    const other = mkdtempSync(join(tmpdir(), 'agentd-scan-'))
    repo(join(other, 'agentd'))
    mkdirSync(join(root, 'labs'))
    symlinkSync(other, join(root, 'labs', 'gen'))
    const projects = scanRoots([root, other], 3)
    expect(projects.map(p => p.id)).toEqual(['agentd'])
    expect(scanRoots([other, other], 3)).toHaveLength(1)
  })
})

describe('assignIds', () => {
  test('adds parent folders only where names clash', () => {
    const root = '/r/GitHub'
    const ids = assignIds([
      { path: '/r/GitHub/Acme/acme', root },
      { path: '/r/GitHub/old/acme', root },
      { path: '/r/GitHub/memos', root },
    ]).map(p => p.id)
    expect(ids).toEqual(['Acme/acme', 'memos', 'old/acme'])
  })

  test('clashing names across roots fall back to the root folder name', () => {
    const ids = assignIds([
      { path: '/a/GitHub/x', root: '/a/GitHub' },
      { path: '/b/Work/x', root: '/b/Work' },
    ]).map(p => p.id)
    expect(ids).toEqual(['GitHub/x', 'Work/x'])
  })
})

describe('resolveProject', () => {
  const root = '/r'
  const projects = assignIds([
    { path: '/r/Acme/acme', root },
    { path: '/r/Acme/acme-flutter', root },
    { path: '/r/Acme/acme-compute', root },
    { path: '/r/old/acme', root },
    { path: '/r/memos', root },
  ])

  test('an exact id is found', () => {
    expect(resolveProject('acme-flutter', projects)).toMatchObject({
      kind: 'found',
      project: { path: '/r/Acme/acme-flutter' },
    })
  })

  test('a folder name two repositories share is ambiguous', () => {
    const r = resolveProject('acme', projects)
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous')
      expect(r.candidates.map(p => p.id).sort()).toEqual(['Acme/acme', 'old/acme'])
  })

  test('a unique fragment is found; case and spaces do not matter', () => {
    expect(resolveProject('Acme Compute', projects)).toMatchObject({ kind: 'found' })
    expect(resolveProject('mem', projects)).toMatchObject({
      kind: 'found',
      project: { id: 'memos' },
    })
  })

  test('an absolute path is found only when registered', () => {
    expect(resolveProject('/r/memos', projects)).toMatchObject({ kind: 'found' })
    expect(resolveProject('/elsewhere', projects).kind).toBe('none')
  })

  test('nothing close gives suggestions', () => {
    const r = resolveProject('memoz', projects)
    expect(r.kind).toBe('none')
    if (r.kind === 'none') expect(r.suggestions[0]?.id).toBe('memos')
  })
})
