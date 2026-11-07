// The seam between the ticket logic and dsh. `service.ts` only talks to these
// two interfaces; `dsh.ts` implements them on the real services, tests on fakes.

export type Liveness = 'idle' | 'running' | 'gone'

/** How text enters a Session: a new turn, the next step of a running one, or quiet context. */
export type Delivery = 'followup' | 'steer' | 'inject'

export interface WorkerRuntime {
  /** Creates the Worker's Session in `cwd` under the given id; does not start a turn. */
  create(input: { sessionId: string; cwd: string; preset: string }): Promise<void>
  /**
   * Delivers text to a Worker. `relay` marks it as coming from the Router
   * session (an agent message), otherwise from this plugin. Resumes a cold
   * Session. False when the Session cannot be reached.
   */
  send(sessionId: string, text: string, mode: Delivery): Promise<boolean>
  /** Stops the current turn, keeping the Session. */
  cancel(sessionId: string): Promise<void>
  status(sessionId: string): Liveness
  /**
   * The Worker's conversation as lines (a text block or a tool call each),
   * oldest first, for chain-of-recall reads; undefined when it cannot be opened.
   */
  transcript(sessionId: string): Promise<TranscriptLine[] | undefined>
}

export type TranscriptLine = { role: string; text: string }

export interface RouterLink {
  /** The Router Session id, creating the Session on first use. */
  ensure(): Promise<string>
  status(): Liveness
  /** Hands the Router text that must be acted on (a new turn when idle). */
  deliver(text: string, summary: string): Promise<boolean>
  /** Adds quiet context the Router reads at its next step. */
  note(text: string): Promise<boolean>
}
