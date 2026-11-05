import type { Ticket, TicketEvent } from '../core/types.js'

// The plugin's durable records. In dsh they live in a storage-domain (JSON
// under ~/.dsh/storages); tests use the in-memory form. Reads are synchronous,
// writes resolve once durable — the storage-domain contract.

export interface Table<T> {
  get(key: string): T | undefined
  entries(): Iterable<[string, T]>
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
}

export type Meta = {
  routerSessionId?: string
  nextTicketId: number
  nextEventId: number
  /** Events up to this id were handed to the Router. */
  routerSeenEventId: number
  /** Set when the Router's context was compacted: the next delivery carries the overview. */
  overviewDue: boolean
}

export type Tables = {
  tickets: Table<Ticket>
  events: Table<TicketEvent>
  meta: Table<Meta>
}

export const META_KEY = 'meta'
export const INITIAL_META: Meta = {
  nextTicketId: 1,
  nextEventId: 1,
  routerSeenEventId: 0,
  overviewDue: true,
}

class MemoryTable<T> implements Table<T> {
  private readonly records = new Map<string, T>()
  get(key: string): T | undefined {
    return this.records.get(key)
  }
  entries(): Iterable<[string, T]> {
    return [...this.records.entries()]
  }
  async put(key: string, value: T): Promise<void> {
    this.records.set(key, structuredClone(value))
  }
  async delete(key: string): Promise<boolean> {
    return this.records.delete(key)
  }
}

export function memoryTables(): Tables {
  return { tickets: new MemoryTable(), events: new MemoryTable(), meta: new MemoryTable() }
}

// storage-domain validates each record through a zod-like `parse`. The records
// are written only by this plugin, so the schema checks shape loosely and
// rejects only what would break reads.
const looseObject = (name: string, required: string[]) => ({
  parse(raw: unknown): unknown {
    if (typeof raw !== 'object' || raw === null) throw new Error(`${name}: not an object`)
    for (const key of required) {
      if (!(key in raw)) throw new Error(`${name}: missing ${key}`)
    }
    return raw
  },
  safeParse(raw: unknown): { success: boolean } {
    try {
      this.parse(raw)
      return { success: true }
    } catch {
      return { success: false }
    }
  },
})

/** The storage-domain declaration; `defineDomain` is an identity helper, so it is inlined. */
export const SUPERAGENT_DOMAIN = {
  name: 'superagent',
  version: 1,
  tables: {
    tickets: { valueSchema: looseObject('ticket', ['id', 'state', 'projectPath']) },
    events: { valueSchema: looseObject('event', ['id', 'ticketId', 'kind']) },
    meta: { valueSchema: looseObject('meta', ['nextTicketId', 'nextEventId']) },
  },
}

type DomainHandle = {
  table(name: string): Table<unknown>
  close(): Promise<void>
}

export type StorageDomainService = { open(spec: unknown): Promise<DomainHandle> }

export async function openDomainTables(
  storageDomain: StorageDomainService,
): Promise<{ tables: Tables; close: () => Promise<void> }> {
  const domain = await storageDomain.open(SUPERAGENT_DOMAIN)
  const tables: Tables = {
    tickets: domain.table('tickets') as Table<Ticket>,
    events: domain.table('events') as Table<TicketEvent>,
    meta: domain.table('meta') as Table<Meta>,
  }
  return { tables, close: () => domain.close() }
}
