/** A small JSON client for the daemon's HTTP API, used by the MCP server and the CLI. */
export class AgentdClient {
  constructor(readonly baseUrl: string) {}

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; data: T }> {
    const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
    if (body !== undefined) init.body = JSON.stringify(body)
    if (signal) init.signal = signal
    const res = await fetch(`${this.baseUrl}${path}`, init)
    const data = (await res.json()) as T
    return { status: res.status, data }
  }

  get<T>(path: string, signal?: AbortSignal) {
    return this.request<T>('GET', path, undefined, signal)
  }

  post<T>(path: string, body: unknown = {}, signal?: AbortSignal) {
    return this.request<T>('POST', path, body, signal)
  }
}
