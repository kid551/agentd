import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { deliveryOf, loadConfig, matchDelivery } from '../src/config.js'

describe('delivery', () => {
  const rules = {
    '/r/Acme': { delivery: 'mr' as const },
    '/r/Acme/Legacy': { delivery: 'local' as const },
    '/r/solo/': { delivery: 'mr' as const },
  }

  test('a folder covers every repository under it; the nearest key wins', () => {
    expect(matchDelivery(rules, 'local', '/r/Acme/acme')).toBe('mr')
    expect(matchDelivery(rules, 'local', '/r/Acme/a/b')).toBe('mr')
    expect(matchDelivery(rules, 'local', '/r/Acme/Legacy')).toBe('local')
    expect(matchDelivery(rules, 'local', '/r/solo')).toBe('mr')
  })

  test('keys are whole path segments, and anything uncovered takes the default', () => {
    expect(matchDelivery(rules, 'local', '/r/Acme-old')).toBe('local')
    expect(matchDelivery(rules, 'local', '/r/Acme/Legacy-2')).toBe('mr')
    expect(matchDelivery(rules, 'mr', '/r/agentd')).toBe('mr')
    expect(matchDelivery({}, 'local', '/r/agentd')).toBe('local')
  })

  test('config keys expand ~ and resolve links, so they meet the scanner real paths', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'agentd-config-')))
    mkdirSync(join(home, 'real', 'Acme', 'acme'), { recursive: true })
    symlinkSync(join(home, 'real'), join(home, 'link'))
    const file = join(home, 'config.json')
    writeFileSync(
      file,
      JSON.stringify({ projects: { [join(home, 'link', 'Acme')]: { delivery: 'mr' } } }),
    )
    const config = loadConfig({ home, db: '', mcpDir: '', logDir: '', config: file })
    expect(config.defaultDelivery).toBe('local')
    // No owner list unless one is written: GitHub repos set to mr are not limited.
    expect(config.githubOwners).toEqual([])
    expect(deliveryOf(config, join(home, 'real', 'Acme', 'acme'))).toBe('mr')
    expect(deliveryOf(config, join(home, 'real', 'other'))).toBe('local')
  })
})
