import { describe, expect, test } from 'vitest'

import { type StopDeps, stopDaemon } from '../src/stop.js'

/** A daemon on the port that exits on /shutdown, on SIGTERM, or never. */
function fake(opts: { hasShutdown: boolean; diesOnKill: boolean }) {
  let up = true
  const killed: number[] = []
  const deps: StopDeps = {
    pid: async () => (up ? 77 : null),
    shutdown: async () => {
      if (opts.hasShutdown) up = false
      return opts.hasShutdown
    },
    kill: pid => {
      killed.push(pid)
      if (opts.diesOnKill) up = false
    },
    sleep: async () => {},
  }
  return { deps, killed }
}

describe('stopDaemon', () => {
  test('nothing running is already stopped', async () => {
    const { deps, killed } = fake({ hasShutdown: true, diesOnKill: true })
    deps.pid = async () => null
    expect(await stopDaemon(deps)).toEqual({ ok: true, pid: null })
    expect(killed).toEqual([])
  })

  test('a daemon with /shutdown exits without a signal', async () => {
    const { deps, killed } = fake({ hasShutdown: true, diesOnKill: true })
    expect(await stopDaemon(deps)).toEqual({ ok: true, pid: 77 })
    expect(killed).toEqual([])
  })

  test('a build older than /shutdown is ended by the pid it reported', async () => {
    const { deps, killed } = fake({ hasShutdown: false, diesOnKill: true })
    expect(await stopDaemon(deps)).toEqual({ ok: true, pid: 77 })
    expect(killed).toEqual([77])
  })

  test('a daemon that outlives SIGTERM is reported, not pretended away', async () => {
    const { deps } = fake({ hasShutdown: false, diesOnKill: false })
    expect(await stopDaemon(deps)).toEqual({ ok: false, pid: 77 })
  })
})
