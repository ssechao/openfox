import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSessionRemoteAgentTarget: vi.fn(),
  getProject: vi.fn(),
}))

vi.mock('../db/sessions.js', () => ({
  getSessionRemoteAgentTarget: mocks.getSessionRemoteAgentTarget,
}))
vi.mock('../db/projects.js', () => ({
  getProject: mocks.getProject,
}))

const { resolveRemoteAgentTarget, normalizeRemoteTarget } = await import('./session-target.js')

describe('resolveRemoteAgentTarget', () => {
  beforeEach(() => {
    mocks.getSessionRemoteAgentTarget.mockReset()
    mocks.getProject.mockReset()
  })

  it('prefers the session pin over the project default', () => {
    mocks.getSessionRemoteAgentTarget.mockReturnValue('agent-session')
    mocks.getProject.mockReturnValue({ remoteAgentTarget: 'agent-project' })
    expect(resolveRemoteAgentTarget('p1', 's1')).toBe('agent-session')
  })

  it('falls back to the project default when the session has no pin', () => {
    mocks.getSessionRemoteAgentTarget.mockReturnValue(null)
    mocks.getProject.mockReturnValue({ remoteAgentTarget: 'agent-project' })
    expect(resolveRemoteAgentTarget('p1', 's1')).toBe('agent-project')
  })

  it('returns null when neither layer pins a target', () => {
    mocks.getSessionRemoteAgentTarget.mockReturnValue(null)
    mocks.getProject.mockReturnValue({})
    expect(resolveRemoteAgentTarget('p1', 's1')).toBeNull()
  })

  it('lets an empty session pin opt out of a project default (force local)', () => {
    mocks.getSessionRemoteAgentTarget.mockReturnValue('')
    mocks.getProject.mockReturnValue({ remoteAgentTarget: 'agent-project' })
    expect(resolveRemoteAgentTarget('p1', 's1')).toBe('')
  })

  it('uses the project default when no sessionId is given', () => {
    mocks.getProject.mockReturnValue({ remoteAgentTarget: 'agent-project' })
    expect(resolveRemoteAgentTarget('p1')).toBe('agent-project')
    expect(mocks.getSessionRemoteAgentTarget).not.toHaveBeenCalled()
  })
})

describe('normalizeRemoteTarget', () => {
  it('routes on a non-empty trimmed string', () => {
    expect(normalizeRemoteTarget('agent-a')).toBe('agent-a')
    expect(normalizeRemoteTarget('  agent-a  ')).toBe('agent-a')
  })

  it('treats null, undefined and empty/blank as local', () => {
    expect(normalizeRemoteTarget(null)).toBeNull()
    expect(normalizeRemoteTarget(undefined)).toBeNull()
    expect(normalizeRemoteTarget('')).toBeNull()
    expect(normalizeRemoteTarget('   ')).toBeNull()
  })
})
