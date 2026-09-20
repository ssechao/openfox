import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from './types.js'

const mocks = vi.hoisted(() => ({
  getSessionRemoteAgentTarget: vi.fn(),
  updateSessionRemoteAgentTarget: vi.fn(),
  getProject: vi.fn(),
  updateProject: vi.fn(),
  resolveRemoteAgentTarget: vi.fn(),
}))

vi.mock('../db/sessions.js', () => ({
  getSessionRemoteAgentTarget: mocks.getSessionRemoteAgentTarget,
  updateSessionRemoteAgentTarget: mocks.updateSessionRemoteAgentTarget,
}))
vi.mock('../db/projects.js', () => ({
  getProject: mocks.getProject,
  updateProject: mocks.updateProject,
}))
vi.mock('../remote-agent/session-target.js', () => ({
  resolveRemoteAgentTarget: mocks.resolveRemoteAgentTarget,
}))

const { sessionRemoteAgentTool } = await import('./session-remote-agent.js')

function makeContext(): ToolContext {
  return {
    workdir: '/work',
    sessionId: 'sess-1',
    sessionManager: {
      getSession: () => ({ id: 'sess-1', projectId: 'proj-1' }),
    } as unknown as ToolContext['sessionManager'],
  }
}

describe('session_remote_agent tool', () => {
  beforeEach(() => {
    mocks.getSessionRemoteAgentTarget.mockReset().mockReturnValue(null)
    mocks.updateSessionRemoteAgentTarget.mockReset()
    mocks.getProject.mockReset().mockReturnValue({ remoteAgentTarget: null })
    mocks.updateProject.mockReset()
    mocks.resolveRemoteAgentTarget.mockReset().mockReturnValue(null)
  })

  it('pins the session to a target', async () => {
    const res = await sessionRemoteAgentTool.execute({ action: 'set', target: 'sse-essentiel' }, makeContext())
    expect(res.success).toBe(true)
    expect(mocks.updateSessionRemoteAgentTarget).toHaveBeenCalledWith('sess-1', 'sse-essentiel')
  })

  it('rejects "set" without a target', async () => {
    const res = await sessionRemoteAgentTool.execute({ action: 'set' }, makeContext())
    expect(res.success).toBe(false)
    expect(mocks.updateSessionRemoteAgentTarget).not.toHaveBeenCalled()
  })

  it('forces local with "local" (empty-string pin)', async () => {
    const res = await sessionRemoteAgentTool.execute({ action: 'local' }, makeContext())
    expect(res.success).toBe(true)
    expect(mocks.updateSessionRemoteAgentTarget).toHaveBeenCalledWith('sess-1', '')
  })

  it('clears the session pin (null) and reports the inherited default', async () => {
    mocks.resolveRemoteAgentTarget.mockReturnValue('proj-agent')
    const res = await sessionRemoteAgentTool.execute({ action: 'clear' }, makeContext())
    expect(res.success).toBe(true)
    expect(mocks.updateSessionRemoteAgentTarget).toHaveBeenCalledWith('sess-1', null)
    expect(String(res.output)).toMatch(/proj-agent/)
  })

  it('sets the project default', async () => {
    const res = await sessionRemoteAgentTool.execute({ action: 'project', target: 'build-box' }, makeContext())
    expect(res.success).toBe(true)
    expect(mocks.updateProject).toHaveBeenCalledWith('proj-1', { remoteAgentTarget: 'build-box' })
  })

  it('clears the project default when no target is given', async () => {
    const res = await sessionRemoteAgentTool.execute({ action: 'project' }, makeContext())
    expect(res.success).toBe(true)
    expect(mocks.updateProject).toHaveBeenCalledWith('proj-1', { remoteAgentTarget: null })
  })

  it('reports status', async () => {
    mocks.getSessionRemoteAgentTarget.mockReturnValue('sess-agent')
    mocks.getProject.mockReturnValue({ remoteAgentTarget: 'proj-agent' })
    mocks.resolveRemoteAgentTarget.mockReturnValue('sess-agent')
    const res = await sessionRemoteAgentTool.execute({ action: 'status' }, makeContext())
    expect(res.success).toBe(true)
    const parsed = JSON.parse(String(res.output))
    expect(parsed).toEqual({ sessionPin: 'sess-agent', projectDefault: 'proj-agent', effective: 'sess-agent' })
  })

  it('rejects an unknown action', async () => {
    const res = await sessionRemoteAgentTool.execute({ action: 'nope' }, makeContext())
    expect(res.success).toBe(false)
  })
})
