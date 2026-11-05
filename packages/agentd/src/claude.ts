import { execFile } from 'node:child_process'

/** One background session as `claude agents --json --all` lists it. */
export type WorkerInfo = {
  name: string
  id: string | undefined
  sessionId: string
  cwd: string
  status: string
  state: string | undefined
  /** Set while the process runs; an ended session is listed without one. */
  pid: number | undefined
  startedAt: number
}

/**
 * An ended session stays in the list, `state` set to how it ended (`done`,
 * `stopped`, …) and no `pid`; the same words appear on live sessions too, so
 * only the pid says whether the process is there.
 */
export const isWorkerGone = (w: WorkerInfo): boolean => w.pid === undefined

export type SpawnSpec = {
  name: string
  cwd: string
  model: string
  permissionMode: string
  mcpConfigPath: string
  /** A `--settings` JSON value: the Worker's permission hooks. */
  settings?: string
  systemPrompt: string
  taskPrompt: string
  /** Tools refused on top of AskUserQuestion. */
  disallowedTools?: string[]
  /** A session id to continue instead of starting a new conversation. */
  resume?: string
}

export type SpawnResult =
  { ok: true; bgId: string } | { ok: false; reason: string; isUntrusted: boolean }

/** What the daemon needs from Claude Code; tests give a fake. */
export interface WorkerRuntime {
  spawn(spec: SpawnSpec): Promise<SpawnResult>
  list(): Promise<WorkerInfo[]>
  stop(bgId: string): Promise<void>
}

export const WORKER_TOOLS = [
  'mcp__agentd__report',
  'mcp__agentd__ask',
  'mcp__agentd__done',
  'mcp__agentd__mr_consent',
]

/**
 * The argument vector for one Worker. Each list-taking flag (`--mcp-config`,
 * `--allowedTools`, `--disallowedTools`) is followed by a flag that takes one
 * value, so the task prompt at the end is never read as one of its values.
 */
export function spawnArgv(spec: SpawnSpec): string[] {
  return [
    '--bg',
    '--mcp-config',
    spec.mcpConfigPath,
    '--model',
    spec.model,
    '--allowedTools',
    WORKER_TOOLS.join(','),
    '--permission-mode',
    spec.permissionMode,
    ...(spec.settings ? ['--settings', spec.settings] : []),
    '--disallowedTools',
    ['AskUserQuestion', ...(spec.disallowedTools ?? [])].join(','),
    '--append-system-prompt',
    spec.systemPrompt,
    ...(spec.resume ? ['--resume', spec.resume] : []),
    '-n',
    spec.name,
    spec.taskPrompt,
  ]
}

/** `backgrounded · 2bb79421 · agentd-w-0` → `2bb79421`. */
export function parseBgId(output: string): string | null {
  const match = /backgrounded\s*·\s*([0-9a-z]+)\s*·/i.exec(output)
  return match ? (match[1] as string) : null
}

export function parseAgents(json: string): WorkerInfo[] {
  const list = JSON.parse(json) as Record<string, unknown>[]
  return list
    .filter(a => a.kind === 'background' && typeof a.name === 'string')
    .map(a => ({
      name: a.name as string,
      id: typeof a.id === 'string' ? a.id : undefined,
      sessionId: String(a.sessionId ?? ''),
      cwd: String(a.cwd ?? ''),
      status: String(a.status ?? ''),
      state: typeof a.state === 'string' ? a.state : undefined,
      pid: typeof a.pid === 'number' ? a.pid : undefined,
      startedAt: Number(a.startedAt ?? 0),
    }))
}

type Run = { code: number; stdout: string; stderr: string }

function run(
  bin: string,
  argv: string[],
  cwd: string | undefined,
  timeoutMs: number,
): Promise<Run> {
  return new Promise(resolve => {
    execFile(
      bin,
      argv,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr || (error && !stdout ? error.message : '')),
        })
      },
    )
  })
}

export class ClaudeCli implements WorkerRuntime {
  constructor(private readonly bin: string = process.env.AGENTD_CLAUDE ?? 'claude') {}

  async spawn(spec: SpawnSpec): Promise<SpawnResult> {
    const out = await run(this.bin, spawnArgv(spec), spec.cwd, 90_000)
    const text = `${out.stdout}\n${out.stderr}`
    const bgId = parseBgId(text)
    if (out.code === 0 && bgId) return { ok: true, bgId }
    const isUntrusted = /not trusted/i.test(text)
    const reason = isUntrusted
      ? `${spec.cwd} 尚未被 Claude Code 信任。请在该目录运行一次 \`claude\` 并接受信任提示，然后对这份奏折说「重试」。`
      : `claude --bg 失败（退出码 ${out.code}）：${text.trim().slice(0, 600)}`
    return { ok: false, reason, isUntrusted }
  }

  async list(): Promise<WorkerInfo[]> {
    const out = await run(this.bin, ['agents', '--json', '--all'], undefined, 30_000)
    if (out.code !== 0) throw new Error(`claude agents 失败：${out.stderr.slice(0, 300)}`)
    return parseAgents(out.stdout)
  }

  async stop(bgId: string): Promise<void> {
    await run(this.bin, ['stop', bgId], undefined, 30_000)
  }
}
