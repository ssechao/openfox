// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@shared/types.js'

vi.mock('../../hooks/useAgents', () => ({
  useAgents: () => ({ agents: [{ id: 'scout', name: 'Scout' }], refresh: vi.fn() }),
}))

vi.mock('../../stores/session', () => ({
  useSessionStore: (selector: (state: { subAgentContextStates: Record<string, never> }) => unknown) =>
    selector({ subAgentContextStates: {} }),
}))

vi.mock('../../hooks/useDisplaySettings', () => ({
  useDisplaySettings: () => ({ showThinking: true, showVerboseToolOutput: true }),
}))

vi.mock('../../hooks/useAutoScroll', () => ({
  useAutoScroll: () => ({ isAutoScrollActive: false, setAutoScroll: vi.fn() }),
}))

vi.mock('./AssistantMessage', () => ({
  AssistantMessage: ({ message }: { message: Message }) => (
    <article data-testid="subagent-message">{message.content}</article>
  ),
}))

vi.mock('./ChatMessage', () => ({
  ChatMessage: ({ message }: { message: Message }) => (
    <article data-testid="subagent-message">{message.content}</article>
  ),
}))

import { SubAgentContainer } from './SubAgentContainer'

const REFERENCE_LLM_CALLS = 311

function referenceMessages(): Message[] {
  return Array.from({ length: REFERENCE_LLM_CALLS }, (_, index) => ({
    id: `subagent-message-${index}`,
    role: 'assistant' as const,
    content: `Sub-agent output ${index + 1}`,
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    subAgentId: 'scout-run-1',
    subAgentType: 'scout',
    isStreaming: false,
  }))
}

afterEach(cleanup)

describe('SubAgentContainer long-session rendering', () => {
  it('bounds initial mounts while keeping the complete history accessible', () => {
    render(
      <SubAgentContainer
        messages={referenceMessages()}
        subAgentType="scout"
        subAgentId="scout-run-1"
        isStreaming={false}
      />,
    )

    expect(screen.getAllByTestId('subagent-message')).toHaveLength(30)
    expect(screen.queryByText('Sub-agent output 1')).toBeNull()
    expect(screen.getByText(`Sub-agent output ${REFERENCE_LLM_CALLS}`)).toBeInTheDocument()
    while (screen.queryByRole('button', { name: /earlier|anciens/i })) {
      fireEvent.click(screen.getByRole('button', { name: /earlier|anciens/i }))
    }
    expect(screen.getAllByTestId('subagent-message')).toHaveLength(REFERENCE_LLM_CALLS)
    expect(screen.getByText('Sub-agent output 1')).toBeInTheDocument()
  })
})
