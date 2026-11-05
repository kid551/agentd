import { describe, expect, test } from 'vitest'

import { transition, type Input } from '../src/state.js'
import { TICKET_STATES, type TicketState } from '../src/types.js'

const INPUTS: Input[] = [
  'spawn_ok',
  'spawn_fail',
  'report',
  'ask',
  'answer',
  'message',
  'done_ready',
  'done_blocked',
  'done_failed',
  'done_dropped',
  'stalled',
  'exited',
  'close',
  'stop',
  'retry',
  'resume',
]

// The whole lifecycle, written out: [state, input] → next state, or absent when refused.
const EXPECTED: Record<string, TicketState> = {
  'queued spawn_ok': 'working',
  'queued spawn_fail': 'failed',
  'queued close': 'done',
  'queued stop': 'stopped',
  'working report': 'working',
  'working ask': 'asking',
  'working message': 'working',
  'working done_ready': 'ready',
  'working done_blocked': 'blocked',
  'working done_failed': 'failed',
  'working done_dropped': 'done',
  'working stalled': 'blocked',
  'working exited': 'failed',
  'working close': 'done',
  'working stop': 'stopped',
  'asking report': 'asking',
  'asking answer': 'working',
  'asking message': 'asking',
  'asking done_ready': 'ready',
  'asking done_blocked': 'blocked',
  'asking done_failed': 'failed',
  'asking done_dropped': 'done',
  'asking exited': 'failed',
  'asking close': 'done',
  'asking stop': 'stopped',
  'ready report': 'working',
  'ready ask': 'asking',
  'ready message': 'working',
  'ready close': 'done',
  'ready stop': 'stopped',
  'blocked report': 'working',
  'blocked ask': 'asking',
  'blocked message': 'working',
  'blocked close': 'done',
  'blocked stop': 'stopped',
  'blocked retry': 'queued',
  'failed report': 'working',
  'failed ask': 'asking',
  'failed message': 'working',
  'failed close': 'done',
  'failed stop': 'stopped',
  'failed retry': 'queued',
  'done message': 'working',
  'stopped resume': 'working',
}

describe('transition', () => {
  for (const state of TICKET_STATES) {
    for (const input of INPUTS) {
      const want = EXPECTED[`${state} ${input}`]
      test(`${state} + ${input} → ${want ?? 'refused'}`, () => {
        const got = transition(state, input)
        if (want === undefined) expect(got.ok).toBe(false)
        else expect(got).toEqual({ ok: true, to: want })
      })
    }
  }

  test('a person-stopped ticket takes nothing but resume, not even a message', () => {
    for (const input of INPUTS) expect(transition('stopped', input).ok).toBe(input === 'resume')
  })
})
