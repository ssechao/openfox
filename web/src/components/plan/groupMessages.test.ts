// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { groupMessages, getGroupScanCountForTest, resetGroupScanCountForTest } from './groupMessages'
import type { Message } from '@shared/types.js'
import type { DisplayItem } from './groupMessages'

function createMessage(
  id: string,
  role: 'user' | 'assistant' | 'system' | 'tool' = 'assistant',
  content: string = 'Test content',
  extras: Partial<Message> = {},
): Message {
  return {
    id,
    role,
    content,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isStreaming: false,
    ...extras,
  } as Message
}

function assertItemsIdentical(messages: Message[], items: DisplayItem[]): void {
  const newItems = groupMessages(messages, items)
  expect(items.length).toBe(newItems.length)
  for (let i = 0; i < items.length; i++) {
    expect(items[i]).toBe(newItems[i])
  }
}

describe('groupMessages identity preservation', () => {
  it('should preserve object identity for unchanged messages', () => {
    const msg1 = createMessage('msg-1', 'user', 'Hello')
    const msg2 = createMessage('msg-2', 'assistant', 'Hi there')
    const msg3 = createMessage('msg-3', 'user', 'How are you?')

    const initialItems = groupMessages([msg1, msg2, msg3])
    assertItemsIdentical([msg1, msg2, msg3], initialItems)
  })

  it('should create new objects only for changed messages', () => {
    const msg1 = createMessage('msg-1', 'user', 'Hello')
    const msg2 = createMessage('msg-2', 'assistant', 'Hi there')
    const msg3 = createMessage('msg-3', 'user', 'How are you?')
    const msg4 = createMessage('msg-4', 'assistant', 'I am good')

    const initialItems = groupMessages([msg1, msg2, msg3])

    // Add a new message, passing previous items
    const newItems = groupMessages([msg1, msg2, msg3, msg4], initialItems)

    // First 3 items should be identical
    expect(initialItems[0]).toBe(newItems[0])
    expect(initialItems[1]).toBe(newItems[1])
    expect(initialItems[2]).toBe(newItems[2])

    // Fourth item should be new
    expect(newItems[3]).toBeDefined()
  })

  it('should update only the changed message item', () => {
    const msg1 = createMessage('msg-1', 'user', 'Hello')
    const msg2 = createMessage('msg-2', 'assistant', 'Hi there')
    const msg3 = createMessage('msg-3', 'user', 'How are you?')

    const initialItems = groupMessages([msg1, msg2, msg3])

    // Update msg2 content
    const updatedMsg2 = createMessage('msg-2', 'assistant', 'Hello! How can I help?')
    const newItems = groupMessages([msg1, updatedMsg2, msg3], initialItems)

    // msg1 and msg3 items should be identical
    expect(initialItems[0]).toBe(newItems[0])
    expect(initialItems[2]).toBe(newItems[2])

    // msg2 item should be different (new object)
    expect(initialItems[1]).not.toBe(newItems[1])
  })

  it('should handle sub-agent message grouping with identity preservation', () => {
    const msg1 = createMessage('msg-1', 'user', 'Task')
    const msg2 = createMessage('msg-2', 'assistant', 'Working on it', {
      subAgentId: 'agent-1',
      subAgentType: 'verifier' as const,
    })
    const msg3 = createMessage('msg-3', 'assistant', 'Still working', {
      subAgentId: 'agent-1',
      subAgentType: 'verifier' as const,
    })
    const msg4 = createMessage('msg-4', 'user', 'Next question')

    const initialItems = groupMessages([msg1, msg2, msg3, msg4])
    assertItemsIdentical([msg1, msg2, msg3, msg4], initialItems)
  })

  it('should render criteria-only messages as regular message items', () => {
    const msg1 = createMessage('msg-1', 'user', 'Check criteria')
    const msg2 = createMessage('msg-2', 'assistant', '', {
      toolCalls: [
        {
          id: 'tool-1',
          name: 'session_metadata',
          arguments: { action: 'get', key: 'criteria' },
          startedAt: Date.now(),
        },
      ],
    })
    const msg3 = createMessage('msg-3', 'assistant', '', {
      toolCalls: [
        {
          id: 'tool-2',
          name: 'session_metadata',
          arguments: { action: 'get', key: 'criteria' },
          startedAt: Date.now(),
        },
      ],
    })
    const msg4 = createMessage('msg-4', 'user', 'Next')

    const items = groupMessages([msg1, msg2, msg3, msg4])

    // Each criteria-only message is its own message item (not merged into a batch)
    expect(items.length).toBe(4)
    expect(items[0]).toEqual({ type: 'message', message: msg1 })
    expect(items[1]).toEqual({ type: 'message', message: msg2 })
    expect(items[2]).toEqual({ type: 'message', message: msg3 })
    expect(items[3]).toEqual({ type: 'message', message: msg4 })
  })

  it('should include system-generated auto-prompt messages', () => {
    const msg1 = createMessage('msg-1', 'user', 'Hello')
    const autoPrompt = createMessage('auto-1', 'user', '<system-reminder>Plan Mode</system-reminder>', {
      isSystemGenerated: true,
      messageKind: 'auto-prompt',
    })
    const msg2 = createMessage('msg-2', 'assistant', 'Hi there')

    const items = groupMessages([msg1, autoPrompt, msg2])

    // Should have 3 items (auto-prompt included)
    expect(items.length).toBe(3)
    expect(items[0]).toEqual({ type: 'message', message: msg1 })
    expect(items[1]).toEqual({ type: 'message', message: autoPrompt })
    expect(items[2]).toEqual({ type: 'message', message: msg2 })
  })

  it('should group interleaved parallel sub-agent messages into two complete groups', () => {
    // Simulates two sub-agents running in parallel, messages interleaved
    const a1 = createMessage('a-ctx', 'user', 'context reset', {
      subAgentId: 'agent-a',
      subAgentType: 'explorer' as const,
      messageKind: 'context-reset',
    })
    const b1 = createMessage('b-ctx', 'user', 'context reset', {
      subAgentId: 'agent-b',
      subAgentType: 'code_reviewer' as const,
      messageKind: 'context-reset',
    })
    const a2 = createMessage('a-prompt', 'user', 'explore this', {
      subAgentId: 'agent-a',
      subAgentType: 'explorer' as const,
      messageKind: 'auto-prompt',
    })
    const b2 = createMessage('b-prompt', 'user', 'review this', {
      subAgentId: 'agent-b',
      subAgentType: 'code_reviewer' as const,
      messageKind: 'auto-prompt',
    })
    const a3 = createMessage('a-result', 'assistant', 'found files', {
      subAgentId: 'agent-a',
      subAgentType: 'explorer' as const,
    })
    const b3 = createMessage('b-result', 'assistant', 'found issues', {
      subAgentId: 'agent-b',
      subAgentType: 'code_reviewer' as const,
    })

    const items = groupMessages([a1, b1, a2, b2, a3, b3])

    // Should produce exactly 2 sub-agent groups (not 6 individual ones)
    expect(items.length).toBe(2)
    expect(items[0]).toEqual({
      type: 'subagent',
      subAgentId: 'agent-a',
      subAgentType: 'explorer',
      messages: [a1, a2, a3],
    })
    expect(items[1]).toEqual({
      type: 'subagent',
      subAgentId: 'agent-b',
      subAgentType: 'code_reviewer',
      messages: [b1, b2, b3],
    })
  })

  it('should preserve order by first message when sub-agents interleave', () => {
    // Sub-agent B's first message appears before sub-agent A's first message
    const b1 = createMessage('b-1', 'user', 'B first', {
      subAgentId: 'agent-b',
      subAgentType: 'code_reviewer' as const,
    })
    const a1 = createMessage('a-1', 'user', 'A second', {
      subAgentId: 'agent-a',
      subAgentType: 'explorer' as const,
    })
    const b2 = createMessage('b-2', 'assistant', 'B continues', {
      subAgentId: 'agent-b',
      subAgentType: 'code_reviewer' as const,
    })
    const a2 = createMessage('a-2', 'assistant', 'A continues', {
      subAgentId: 'agent-a',
      subAgentType: 'explorer' as const,
    })

    const items = groupMessages([b1, a1, b2, a2])

    // Group B should appear first (its first message comes first)
    expect(items.length).toBe(2)
    expect(items[0]).toEqual({
      type: 'subagent',
      subAgentId: 'agent-b',
      subAgentType: 'code_reviewer',
      messages: [b1, b2],
    })
    expect(items[1]).toEqual({
      type: 'subagent',
      subAgentId: 'agent-a',
      subAgentType: 'explorer',
      messages: [a1, a2],
    })
  })

  it('should interleave regular messages between sub-agent groups correctly', () => {
    const user1 = createMessage('u1', 'user', 'First question')
    const a1 = createMessage('a-1', 'user', 'explorer prompt', {
      subAgentId: 'agent-a',
      subAgentType: 'explorer' as const,
    })
    const a2 = createMessage('a-2', 'assistant', 'explorer result', {
      subAgentId: 'agent-a',
      subAgentType: 'explorer' as const,
    })
    const user2 = createMessage('u2', 'user', 'Second question')
    const b1 = createMessage('b-1', 'user', 'reviewer prompt', {
      subAgentId: 'agent-b',
      subAgentType: 'code_reviewer' as const,
    })
    const b2 = createMessage('b-2', 'assistant', 'reviewer result', {
      subAgentId: 'agent-b',
      subAgentType: 'code_reviewer' as const,
    })
    const user3 = createMessage('u3', 'user', 'Third question')

    const items = groupMessages([user1, a1, a2, user2, b1, b2, user3])

    expect(items.length).toBe(5)
    expect(items[0]).toEqual({ type: 'message', message: user1 })
    expect(items[1]).toEqual({
      type: 'subagent',
      subAgentId: 'agent-a',
      subAgentType: 'explorer',
      messages: [a1, a2],
    })
    expect(items[2]).toEqual({ type: 'message', message: user2 })
    expect(items[3]).toEqual({
      type: 'subagent',
      subAgentId: 'agent-b',
      subAgentType: 'code_reviewer',
      messages: [b1, b2],
    })
    expect(items[4]).toEqual({ type: 'message', message: user3 })
  })

  it('should split sub-agent groups at context window boundaries', () => {
    // Messages spanning a context window boundary should be split
    // because the compaction represents a real discontinuity
    const a1 = createMessage('a-1', 'user', 'A first', {
      subAgentId: 'agent-a',
      subAgentType: 'explorer' as const,
      contextWindowId: 'win-1',
    })
    const b1 = createMessage('b-1', 'user', 'B first', {
      subAgentId: 'agent-b',
      subAgentType: 'code_reviewer' as const,
      contextWindowId: 'win-1',
    })
    const a2 = createMessage('a-2', 'assistant', 'A continues', {
      subAgentId: 'agent-a',
      subAgentType: 'explorer' as const,
      contextWindowId: 'win-2',
    })
    const b2 = createMessage('b-2', 'assistant', 'B continues', {
      subAgentId: 'agent-b',
      subAgentType: 'code_reviewer' as const,
      contextWindowId: 'win-2',
    })

    const items = groupMessages([a1, b1, a2, b2])

    // Groups split at window boundary: win-1 groups, divider, win-2 groups
    expect(items.length).toBe(5)
    expect(items[0]).toEqual({
      type: 'subagent',
      subAgentId: 'agent-a',
      subAgentType: 'explorer',
      messages: [a1],
    })
    expect(items[1]).toEqual({
      type: 'subagent',
      subAgentId: 'agent-b',
      subAgentType: 'code_reviewer',
      messages: [b1],
    })
    expect(items[2]).toEqual({ type: 'context-divider', windowSequence: 2 })
    expect(items[3]).toEqual({
      type: 'subagent',
      subAgentId: 'agent-a',
      subAgentType: 'explorer',
      messages: [a2],
    })
    expect(items[4]).toEqual({
      type: 'subagent',
      subAgentId: 'agent-b',
      subAgentType: 'code_reviewer',
      messages: [b2],
    })
  })
})

// Finding F (remediation plan): grouping runs on every streaming flush over the
// whole history, so one pass per call is the contract.
describe('groupMessages scan cost', () => {
  it('walks each message once even when sub-agent groups interleave', () => {
    const messages: Message[] = []
    for (let i = 0; i < 100; i++) {
      messages.push(
        createMessage(`sub-${i}`, 'assistant', 'sub work', {
          subAgentId: `agent-${i}`,
          subAgentType: 'explorer',
          contextWindowId: 'w1',
        }),
      )
      messages.push(createMessage(`main-${i}`, 'assistant', 'main work', { contextWindowId: 'w1' }))
    }

    resetGroupScanCountForTest()
    const items = groupMessages(messages)

    expect(getGroupScanCountForTest()).toBe(messages.length)
    expect(items).toHaveLength(messages.length)
    expect(items[0]).toMatchObject({ type: 'subagent', subAgentId: 'agent-0' })
    expect(items[2]).toMatchObject({ type: 'subagent', subAgentId: 'agent-1' })
  })
})
