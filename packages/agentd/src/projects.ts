import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { Project, ResolveResult } from './types.js'

const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.venv',
  'Pods',
  '.dart_tool',
])

/**
 * Finds git repositories under each root, `depth` levels deep at most. A
 * repository is not searched inside: nested repositories and worktrees under it
 * belong to it.
 */
export function scanRoots(roots: string[], depth: number): Project[] {
  const found: { path: string; root: string }[] = []
  // A link inside one root, or two roots that overlap, reach a repository twice.
  const seen = new Set<string>()
  const walk = (dir: string, root: string, level: number): void => {
    if (existsSync(join(dir, '.git'))) {
      const real = realpathSync(dir)
      if (!seen.has(real)) found.push({ path: dir, root })
      seen.add(real)
      return
    }
    if (level >= depth) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (SKIP.has(name) || name.startsWith('.')) continue
      const child = join(dir, name)
      try {
        if (statSync(child).isDirectory()) walk(child, root, level + 1)
      } catch {
        // unreadable or vanished: skip
      }
    }
  }
  for (const root of roots) if (existsSync(root)) walk(root, root, 0)
  return assignIds(found)
}

/**
 * Names each repository by its folder name, adding parent folders only where
 * two repositories share a name, so `acme` stays `acme` unless there is
 * another `acme`, when they become `Acme/acme` and `old/acme`.
 */
export function assignIds(found: { path: string; root: string }[]): Project[] {
  const parts = found.map(f => {
    const rel = relative(dirname(f.root), f.path)
    return rel.split(sep).filter(Boolean)
  })
  const ids = parts.map(p => p.slice(-1))
  for (let changed = true; changed;) {
    changed = false
    const counts = new Map<string, number>()
    for (const id of ids) counts.set(id.join('/'), (counts.get(id.join('/')) ?? 0) + 1)
    ids.forEach((id, i) => {
      const all = parts[i] as string[]
      if ((counts.get(id.join('/')) ?? 0) > 1 && id.length < all.length) {
        ids[i] = all.slice(-(id.length + 1))
        changed = true
      }
    })
  }
  return found
    .map((f, i) => ({ id: (ids[i] as string[]).join('/'), path: f.path, root: f.root }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

const norm = (s: string): string => s.toLowerCase().replace(/[\s_]+/g, '-')

/** Resolves what the person called a project. Only a single match passes. */
export function resolveProject(query: string, projects: Project[]): ResolveResult {
  const q = query.trim()
  if (isAbsolute(q)) {
    const path = resolve(q)
    const hit = projects.find(p => p.path === path)
    return hit ? { kind: 'found', project: hit } : { kind: 'none', suggestions: [] }
  }
  const nq = norm(q)
  const exact = projects.filter(p => norm(p.id) === nq)
  if (exact.length === 1) return { kind: 'found', project: exact[0] as Project }
  const byName = projects.filter(p => norm(basename(p.path)) === nq)
  if (byName.length === 1) return { kind: 'found', project: byName[0] as Project }
  if (byName.length > 1) return { kind: 'ambiguous', candidates: byName }
  const partial = projects.filter(p => norm(p.id).includes(nq))
  if (partial.length === 1) return { kind: 'found', project: partial[0] as Project }
  if (partial.length > 1) return { kind: 'ambiguous', candidates: partial.slice(0, 8) }
  const ranked = projects
    .map(p => ({ p, d: distance(nq, norm(basename(p.path))) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .map(r => r.p)
  return { kind: 'none', suggestions: ranked }
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] as number
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j] as number
      row[j] = Math.min(
        (row[j] as number) + 1,
        (row[j - 1] as number) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      prev = keep
    }
  }
  return row[b.length] as number
}
