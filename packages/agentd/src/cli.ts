import './quiet.js'

import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { ClaudeCli } from './claude.js'
import { AgentdClient } from './client.js'
import { agentdPaths, ensureDirs, loadConfig } from './config.js'
import { Daemon } from './daemon.js'
import { createHttpServer } from './http.js'
import { stopDaemon } from './stop.js'
import { Store } from './store.js'
import type { TicketView } from './types.js'

const USAGE = `agentd <command>

  serve [--port N] [--idle-exit SECONDS]   run the daemon in the foreground
        [--detach]                         start it in the background, logging to ~/.agentd/logs, and return
  restart                                  stop the running daemon (by pid if it has no /shutdown), start the built one
  status                                  is the daemon up, what waits for you
  tickets [--all]                          list tickets
  projects [--rescan]                      list the projects Workers may be sent to
  dispatch <project> <title> <prompt>      open a ticket (for testing without the Router)
`

const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`)

async function serve(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      'idle-exit': { type: 'string' },
      detach: { type: 'boolean' },
    },
  })
  const paths = agentdPaths()
  ensureDirs(paths)
  if (values.detach) {
    // A child of its own session, holding only the log file: whoever started
    // us (the router mod's $.process.run) sees us exit at once, and no pipe of
    // theirs stays open in the daemon.
    const out = openSync(join(paths.logDir, 'daemon.log'), 'a')
    const rest = args.filter(a => a !== '--detach')
    const child = spawn(process.execPath, [process.argv[1] as string, 'serve', ...rest], {
      detached: true,
      stdio: ['ignore', out, out],
    })
    child.unref()
    console.log(`agentd starting as ${child.pid}`)
    return
  }
  const config = loadConfig(paths, {
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values['idle-exit'] ? { idleExitSeconds: Number(values['idle-exit']) } : {}),
  })
  const store = new Store(paths.db, { inlineChars: config.router.inlineChars })
  const daemon = new Daemon({ store, runtime: new ClaudeCli(), config, paths, log })
  const server = createHttpServer(daemon, () => shutdown())
  // Long polls hold a request open; keep idle sockets from piling up.
  server.keepAliveTimeout = 5_000

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, '127.0.0.1', () => resolve())
  }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE') throw error
    const up = await new AgentdClient(`http://127.0.0.1:${config.port}`)
      .get<{ ok: boolean }>('/status')
      .catch(() => null)
    store.close()
    if (up?.data.ok) {
      log(`agentd already runs on ${config.port}`)
      process.exit(0)
    }
    throw error
  })

  log(`agentd ${process.pid} listening on 127.0.0.1:${config.port}, state in ${paths.home}`)
  daemon.rescan()
  // Lanes a cleanup missed (a crash between a merge and its cleanup); nothing waits on it.
  void daemon.sweep()
  const ticker = setInterval(() => void daemon.tick(), 3_000)
  const idle = setInterval(() => {
    if (config.idleExitSeconds <= 0 || !daemon.isIdle()) return
    if (Date.now() - daemon.lastActivity > config.idleExitSeconds * 1000) {
      log(`idle for ${config.idleExitSeconds}s with no live ticket, exiting`)
      shutdown()
    }
  }, 30_000)

  function shutdown(): void {
    log('shutting down')
    clearInterval(ticker)
    clearInterval(idle)
    server.close()
    server.closeAllConnections()
    store.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

function line(t: TicketView): string {
  const q = t.openQuestion ? ` · 问：${t.openQuestion.question.slice(0, 50)}` : ''
  return `#${t.id}  ${t.state.padEnd(8)} ${t.project}  ${t.title}${q}`
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'serve') return serve(rest)
  const config = loadConfig(agentdPaths())
  const client = new AgentdClient(`http://127.0.0.1:${config.port}`)
  const down = (): never => {
    console.error(`agentd 不在线（127.0.0.1:${config.port}）。先运行 agentd serve。`)
    process.exit(1)
  }
  if (command === 'restart') {
    const stopped = await stopDaemon({
      pid: () =>
        client
          .get<{ pid?: number }>('/status')
          .then(r => r.data.pid ?? 0)
          .catch(() => null),
      shutdown: () =>
        client
          .post('/shutdown')
          .then(r => r.status < 300)
          .catch(() => false),
      kill: pid => {
        if (pid > 0) process.kill(pid, 'SIGTERM')
      },
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    })
    if (!stopped.ok) {
      console.error(`旧的 agentd（pid ${stopped.pid}）没有退出，手动 kill 它后再运行。`)
      process.exit(1)
    }
    if (stopped.pid !== null) console.log(`旧的 agentd（pid ${stopped.pid}）已退出`)
    // The same flags the Router's /agentd start uses.
    return serve(['--detach', '--port', String(config.port), '--idle-exit', '1800'])
  }
  if (command === 'status') {
    const r = await client.get<Record<string, unknown>>('/status').catch(down)
    console.log(JSON.stringify(r.data, null, 2))
    return
  }
  if (command === 'tickets') {
    const all = rest.includes('--all')
    const r = await client.get<TicketView[]>(`/tickets?state=${all ? 'all' : 'open'}`).catch(down)
    console.log(r.data.length === 0 ? '没有奏折。' : r.data.map(line).join('\n'))
    return
  }
  if (command === 'projects') {
    const r = rest.includes('--rescan')
      ? await client.post<{ id: string; path: string }[]>('/projects/rescan').catch(down)
      : await client.get<{ id: string; path: string }[]>('/projects').catch(down)
    console.log(r.data.map(p => `${p.id.padEnd(40)} ${p.path}`).join('\n'))
    return
  }
  if (command === 'dispatch') {
    const [project, title, prompt] = rest
    if (!project || !title || !prompt) {
      console.error(USAGE)
      process.exit(2)
    }
    const r = await client
      .post<{ ok: boolean; ticket?: TicketView; reason?: string }>('/tickets', {
        project,
        title,
        prompt,
      })
      .catch(down)
    console.log(r.data.ok && r.data.ticket ? line(r.data.ticket) : r.data.reason)
    return
  }
  console.log(USAGE)
  if (command && command !== 'help') process.exit(2)
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
})
