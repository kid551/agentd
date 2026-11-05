/** What stopping a running daemon needs from the outside world. */
export interface StopDeps {
  /** The pid the daemon reports, or null when nothing answers. */
  pid(): Promise<number | null>
  /** Asks the daemon to exit; false when it refuses or has no such route. */
  shutdown(): Promise<boolean>
  kill(pid: number): void
  sleep(ms: number): Promise<void>
}

/**
 * Stops whichever daemon answers on the port. Builds older than /shutdown
 * answer it with 404 and keep running, so a daemon still up after asking is
 * sent SIGTERM by the pid it reported.
 */
export async function stopDaemon(deps: StopDeps): Promise<{ ok: boolean; pid: number | null }> {
  const pid = await deps.pid()
  if (pid === null) return { ok: true, pid }
  const isDown = async (): Promise<boolean> => {
    for (let i = 0; i < 20; i++) {
      if ((await deps.pid()) === null) return true
      await deps.sleep(250)
    }
    return false
  }
  if ((await deps.shutdown()) && (await isDown())) return { ok: true, pid }
  deps.kill(pid)
  return { ok: await isDown(), pid }
}
