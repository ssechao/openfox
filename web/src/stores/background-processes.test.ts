// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { BackgroundProcess } from '@shared/protocol.js'
import { useBackgroundProcessesStore } from './background-processes'

// Session-scoped signatures of lot 10h2, typed here so the RED commit compiles.
type SessionScopedStore = {
  handleMessage: (type: string, payload: Record<string, unknown>, sessionId?: string) => void
  setProcesses: (sessionId: string, processes: BackgroundProcess[]) => void
}
const scoped = () => useBackgroundProcessesStore.getState() as unknown as SessionScopedStore

function processOf(id: string, sessionId: string): BackgroundProcess {
  return {
    id,
    sessionId,
    name: id,
    command: 'sleep 60',
    cwd: '/project',
    pid: 1,
    status: 'running',
    exitCode: null,
    createdAt: 1,
    startedAt: 1,
    endedAt: null,
  }
}

vi.mock('../lib/api', () => ({
  authFetch: vi.fn(),
}))

describe('useBackgroundProcessesStore', () => {
  beforeEach(() => {
    useBackgroundProcessesStore.setState({ processes: [], logs: {} })
  })

  describe('handleMessage backgroundProcess.started', () => {
    it('registers the process with its launch command and working directory', () => {
      useBackgroundProcessesStore.getState().handleMessage('backgroundProcess.started', {
        processId: 'proc-1',
        name: 'dev-server',
        command: 'npm run dev',
        cwd: '/project',
        pid: 4321,
        status: 'running',
      })

      const processes = useBackgroundProcessesStore.getState().processes
      expect(processes).toHaveLength(1)
      expect(processes[0]).toMatchObject({
        id: 'proc-1',
        name: 'dev-server',
        command: 'npm run dev',
        cwd: '/project',
        pid: 4321,
        status: 'running',
      })
    })
  })

  describe('session scoping', () => {
    it('keeps the session of a started process', () => {
      scoped().handleMessage(
        'backgroundProcess.started',
        {
          processId: 'proc-a',
          name: 'a',
          command: 'sleep 60',
          cwd: '/project',
          pid: 1,
          status: 'running',
        },
        'sess-a',
      )
      expect(useBackgroundProcessesStore.getState().processes.map((p) => p.sessionId)).toEqual(['sess-a'])
    })

    it('replaces only the processes of the reloaded session', () => {
      useBackgroundProcessesStore.setState({
        processes: [processOf('proc-a', 'sess-a'), processOf('proc-b1', 'sess-b')],
      })
      scoped().setProcesses('sess-b', [processOf('proc-b2', 'sess-b')])
      expect(
        useBackgroundProcessesStore
          .getState()
          .processes.map((p) => p.id)
          .sort(),
      ).toEqual(['proc-a', 'proc-b2'])
    })
  })
})
