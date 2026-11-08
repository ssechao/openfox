import { describe, expect, it, vi } from 'vitest'

vi.mock('../events/index.js', () => ({
  getCurrentWindowMessageOptions: () => undefined,
}))

import { drainQueue } from './drain-queue.js'

describe('drainQueue background exit', () => {
  it('persists a background exit as its own system notice', () => {
    const content = 'Background process "x" (p) exited with code 0.\n<process-output>\ndone\n</process-output>'
    const append = vi.fn()
    const onMessage = vi.fn()
    const sessionManager = {
      drainAsapMessages: () => [
        {
          queueId: 'q-1',
          mode: 'asap' as const,
          content,
          queuedAt: '2026-11-08T12:00:00.000Z',
          messageKind: 'background-exit',
        },
      ],
      getQueueState: () => [],
    }

    drainQueue(sessionManager as never, 'sess-1', append, onMessage)

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message.start',
        data: expect.objectContaining({
          role: 'user',
          content,
          isSystemGenerated: true,
          messageKind: 'background-exit',
        }),
      }),
    )
    const broadcast = onMessage.mock.calls.find((call) => call[0]?.type === 'chat.message')
    expect(broadcast?.[0]?.payload?.message?.messageKind).toBe('background-exit')
    expect(broadcast?.[0]?.payload?.message?.isSystemGenerated).toBe(true)
  })
})
