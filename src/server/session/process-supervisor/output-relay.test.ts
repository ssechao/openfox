import { describe, expect, it, vi } from 'vitest'
import type { SupervisorToGatewayMessage } from './protocol.js'
import { createWorkerOutputRelay } from './output-relay.js'

describe('createWorkerOutputRelay', () => {
  it('relay stays stopped under IPC backpressure until the pending send drains', () => {
    let now = 0
    const drains: Array<() => void> = []
    const messages: SupervisorToGatewayMessage[] = []
    const send = vi.fn((message: SupervisorToGatewayMessage, onDrain?: () => void) => {
      messages.push(message)
      if (onDrain) drains.push(onDrain)
      return messages.length !== 1
    })
    const relay = createWorkerOutputRelay({ workerKey: 'worker-1', send, now: () => now })

    relay.write('stdout', Buffer.from('first'))
    now = 2_000
    relay.write('stdout', Buffer.from('second'))

    expect(messages).toHaveLength(1)
    drains[0]!()
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({ chunk: expect.stringContaining('second') })
  })

  it('completes close only after backpressured output drains', () => {
    const drains: Array<() => void> = []
    const send = vi.fn((_message: SupervisorToGatewayMessage, onDrain?: () => void) => {
      if (onDrain) drains.push(onDrain)
      return send.mock.calls.length > 1
    })
    const relay = createWorkerOutputRelay({ workerKey: 'worker-1', send })
    const closed = vi.fn()

    relay.write('stdout', Buffer.from('first'))
    relay.write('stdout', Buffer.from('final'))
    relay.close(closed)

    expect(closed).not.toHaveBeenCalled()
    drains[0]!()
    expect(send).toHaveBeenCalledTimes(2)
    expect(closed).toHaveBeenCalledOnce()
  })
})
