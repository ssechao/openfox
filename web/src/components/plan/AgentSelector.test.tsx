// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EffortChangeGateProvider } from './EffortChangeGate'
import { clearCache } from '../../lib/resourceCache'
import { readAgents } from '../../lib/resources'
import { loadDefaultAgents } from '../../../../src/server/agents/registry'

const mockSwitchMode = vi.fn().mockResolvedValue(undefined)
const mockPinEffort = vi.fn().mockResolvedValue({})
const mockClearPin = vi.fn().mockResolvedValue({})
const mockSetNightMode = vi.fn().mockResolvedValue(true)

vi.mock('../../stores/session', () => ({
  useSessionStore: (selector: (s: unknown) => unknown) =>
    selector({
      switchMode: mockSwitchMode,
      pinSessionEffort: mockPinEffort,
      clearSessionEffortPin: mockClearPin,
      setNightMode: mockSetNightMode,
    }),
}))

let mockSessionMode = 'builder'
let mockWarmCache = true
let mockNightMode = false

vi.mock('../../stores/session/session-scope', () => ({
  useSessionScope: () => 'session-1',
  useScopedPaneState: (_id: string, _pick: unknown, flatPick: (s: unknown) => unknown) =>
    flatPick({
      currentSession: {
        id: 'session-1',
        mode: mockSessionMode,
        providerReasoningEffort: 'high',
        nightMode: mockNightMode,
      },
      contextState: { warmCache: mockWarmCache },
    }),
}))

const mockAuthFetch = vi.hoisted(() => vi.fn())
let mockOverrides: Record<string, string> = {}

vi.mock('../../lib/api', () => ({
  authFetch: mockAuthFetch,
}))

vi.mock('../../hooks/useProviders', () => ({
  useProviders: () => ({ providers: [], activeProviderId: null, refresh: vi.fn(), loading: false }),
}))

vi.mock('../../hooks/useConfig', () => ({
  useConfig: () => ({
    config: { defaultModelSelection: null },
    refresh: vi.fn(),
    loading: false,
  }),
}))

vi.mock('../../hooks/useKeybindings', () => ({
  useKeybindings: () => ({ agentSwitching: [] }),
}))

vi.mock('../../hooks/useClickOutside', () => ({
  useClickOutside: () => {},
}))

vi.mock('../settings/AgentsModal', () => ({
  AgentsModal: () => null,
}))

vi.mock('../shared/icons', () => ({
  ChevronDownIcon: () => <svg>v</svg>,
  CheckIcon: () => <svg>✓</svg>,
  MoonIcon: () => <svg data-testid="moon-icon">🌙</svg>,
}))

import { AgentSelector } from './AgentSelector'

let defaultAgentMetadata: Awaited<ReturnType<typeof loadDefaultAgents>>[number]['metadata'][] = []

beforeAll(async () => {
  defaultAgentMetadata = (await loadDefaultAgents()).map((agent) => agent.metadata)
})

function agentsPayload(overrides: Record<string, string>) {
  return {
    defaults: defaultAgentMetadata,
    userItems: [],
    projectItems: [],
    modelOverrides: overrides,
  }
}

async function renderSelector() {
  mockAuthFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => agentsPayload(mockOverrides),
  }))
  const utils = render(
    <EffortChangeGateProvider>
      <AgentSelector />
    </EffortChangeGateProvider>,
  )
  // Loadership is implicit: wait for the resource cache to land the payload so
  // the effort gate reads the current overrides.
  await waitFor(() => expect(readAgents()?.modelOverrides).toEqual(mockOverrides))
  await userEvent.click(screen.getByTitle('Switch agent'))
  return utils
}

function dropdownAgent(agentName: string): HTMLElement {
  // The trigger button echoes the current agent's name, so scope queries to
  // the dropdown menu (the absolutely-positioned list under the trigger).
  const buttons = screen.getAllByText(agentName)
  const target = buttons.find((b) => b.closest('div.absolute'))
  if (!target) throw new Error(`Dropdown entry for "${agentName}" not found`)
  return target
}

describe('AgentSelector — effort-change gate (case 2a)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearCache()
    mockOverrides = {}
    mockSessionMode = 'builder'
    mockWarmCache = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('switches directly when the target agent has no effort override', async () => {
    await renderSelector()
    await userEvent.click(dropdownAgent('Planner'))
    expect(screen.queryByText('Reasoning effort change')).toBeNull()
    expect(mockSwitchMode).toHaveBeenCalledWith('session-1', 'planner')
    expect(mockPinEffort).not.toHaveBeenCalled()
    expect(mockClearPin).not.toHaveBeenCalled()
  })

  it('switches directly when the target override effort matches the current effort', async () => {
    mockOverrides = { planner: 'provider-1/model:high' }
    await renderSelector()
    await userEvent.click(dropdownAgent('Planner'))
    expect(screen.queryByText('Reasoning effort change')).toBeNull()
    expect(mockSwitchMode).toHaveBeenCalledWith('session-1', 'planner')
  })

  it('switches directly on a cold cache even when efforts differ', async () => {
    mockOverrides = { planner: 'provider-1/model:max' }
    mockWarmCache = false
    await renderSelector()
    await userEvent.click(dropdownAgent('Planner'))
    expect(screen.queryByText('Reasoning effort change')).toBeNull()
    expect(mockSwitchMode).toHaveBeenCalledWith('session-1', 'planner')
  })

  it('gates and clears the pin on Apply', async () => {
    mockOverrides = { planner: 'provider-1/model:max' }
    await renderSelector()
    await userEvent.click(dropdownAgent('Planner'))

    expect(screen.getByText('Reasoning effort change')).toBeTruthy()
    expect(document.body.textContent).toContain('Planner runs with reasoning effort max (currently high)')
    await userEvent.click(screen.getByText('Apply the reasoning effort (invalidates cache)'))
    expect(mockClearPin).toHaveBeenCalledWith('session-1')
    expect(mockPinEffort).not.toHaveBeenCalled()
    expect(mockSwitchMode).toHaveBeenCalledWith('session-1', 'planner')
  })

  it('gates and pins the current effort on Keep', async () => {
    mockOverrides = { planner: 'provider-1/model:max' }
    await renderSelector()
    await userEvent.click(dropdownAgent('Planner'))
    await userEvent.click(screen.getByText('Keep current reasoning effort'))
    expect(mockPinEffort).toHaveBeenCalledWith('session-1', 'high')
    expect(mockClearPin).not.toHaveBeenCalled()
    expect(mockSwitchMode).toHaveBeenCalledWith('session-1', 'planner')
  })

  it('ignores a click on the already-active agent', async () => {
    mockOverrides = { builder: 'provider-1/model:max' }
    await renderSelector()
    await userEvent.click(dropdownAgent('Builder'))
    expect(screen.queryByText('Reasoning effort change')).toBeNull()
    expect(mockSwitchMode).not.toHaveBeenCalled()
  })

  it('shows Manager with the builtin color and switches to it', async () => {
    await renderSelector()

    const manager = dropdownAgent('Manager')
    expect(['#0d9488', 'rgb(13, 148, 136)']).toContain(manager.style.color)
    await userEvent.click(manager)

    expect(mockSwitchMode).toHaveBeenCalledWith('session-1', 'manager')
  })

  it('does not fetch agents again on re-render (loadership is implicit, not per-render)', async () => {
    const { rerender } = render(
      <EffortChangeGateProvider>
        <AgentSelector />
      </EffortChangeGateProvider>,
    )
    await waitFor(() => expect(readAgents()?.defaults.length).toBe(defaultAgentMetadata.length))
    expect(mockAuthFetch).toHaveBeenCalledTimes(1)

    mockSessionMode = 'planner'
    rerender(
      <EffortChangeGateProvider>
        <AgentSelector />
      </EffortChangeGateProvider>,
    )

    expect(mockAuthFetch).toHaveBeenCalledTimes(1)
  })
})

describe('AgentSelector — night mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearCache()
    mockOverrides = {}
    mockSessionMode = 'builder'
    mockWarmCache = true
    mockNightMode = false
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  function triggerMoon(): Element | null {
    return screen.getByTitle('Switch agent').querySelector('[data-testid="moon-icon"]')
  }

  it('shows an unchecked night mode toggle and switches it on via setNightMode', async () => {
    await renderSelector()

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    expect(checkbox.closest('label')?.textContent).toContain('Night mode')

    await userEvent.click(checkbox)
    expect(mockSetNightMode).toHaveBeenCalledWith('session-1', true)
  })

  it('reflects the active session state and switches night mode off', async () => {
    mockNightMode = true
    await renderSelector()

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    expect(checkbox.checked).toBe(true)

    await userEvent.click(checkbox)
    expect(mockSetNightMode).toHaveBeenCalledWith('session-1', false)
  })

  it('shows a moon indicator before the agent name when night mode is active', async () => {
    const { rerender } = await renderSelector()
    expect(triggerMoon()).toBeNull()

    mockNightMode = true
    rerender(
      <EffortChangeGateProvider>
        <AgentSelector />
      </EffortChangeGateProvider>,
    )
    const moon = triggerMoon()
    expect(moon).not.toBeNull()
    // The indicator renders inside the trigger button, before the agent name
    const name = [...screen.getByTitle('Switch agent').querySelectorAll('span')].find(
      (span) => span.textContent === 'Builder',
    )!
    expect(moon!.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
