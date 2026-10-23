import { beforeEach, describe, it, expect, vi } from 'vitest'
import { spawn } from 'node:child_process'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn().mockReturnValue({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
  }),
}))

vi.mock('./platform.js', () => ({
  getPlatformShell: () => ({ command: '/bin/sh', args: ['-c'] }),
}))

vi.mock('../session/worker/children.js', () => ({
  reserveExclusiveChild: vi.fn(),
  exclusiveChildReservationEnv: vi.fn(),
  finalizeExclusiveChild: vi.fn(),
}))

const { reserveExclusiveChild, exclusiveChildReservationEnv, finalizeExclusiveChild } =
  await import('../session/worker/children.js')
const { spawnShell, spawnShellProcess } = await import('./shell.js')
let killChild: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(finalizeExclusiveChild).mockReset()
  vi.mocked(exclusiveChildReservationEnv).mockReturnValue({ OPENFOX_CHILD_RESERVATION_ID: 'reservation-1' })
  killChild = vi.fn()
  vi.mocked(spawn).mockReturnValue({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: killChild,
    pid: 12345,
  } as never)
  vi.mocked(reserveExclusiveChild).mockReturnValue({ id: 'reservation-1', path: '/tmp/children' })
})

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    fn()
  } finally {
    Object.defineProperty(process, 'platform', { value: original })
  }
}

describe('spawnShell', () => {
  it('passes windowsHide: true and no FORCE_COLOR in spawn options', () => {
    spawnShell('echo hello', { cwd: '/tmp' })

    expect(spawn).toHaveBeenCalledWith(
      '/bin/sh',
      ['-c', 'echo hello'],
      expect.objectContaining({
        cwd: '/tmp',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    )
    // Verify spawnShell does not override FORCE_COLOR (was hardcoded to '0' before)
    const callArgs = vi.mocked(spawn).mock.calls[0]![2] as Record<string, unknown>
    const env = callArgs['env'] as Record<string, string | undefined>
    expect(env['FORCE_COLOR']).toBe(process.env['FORCE_COLOR'])
  })

  it('passes detached flag when set (non-win32)', () => {
    withPlatform('linux', () => {
      spawnShell('echo hello', { cwd: '/tmp', detached: true })
    })

    expect(spawn).toHaveBeenCalledWith('/bin/sh', ['-c', 'echo hello'], expect.objectContaining({ detached: true }))
  })

  it('ignores detached flag on win32 (visible console + MSYS pipe hangs)', () => {
    withPlatform('win32', () => {
      spawnShell('echo hello', { cwd: '/tmp', detached: true })
    })

    expect(spawn).toHaveBeenCalledWith('/bin/sh', ['-c', 'echo hello'], expect.not.objectContaining({ detached: true }))
  })

  it('does not set detached when not requested', () => {
    spawnShell('echo hello', { cwd: '/tmp' })

    expect(spawn).toHaveBeenCalledWith('/bin/sh', ['-c', 'echo hello'], expect.not.objectContaining({ detached: true }))
  })

  it('reserves before spawning and finalizes immediately after', () => {
    spawnShell('echo hello', { cwd: '/tmp' })

    expect(vi.mocked(reserveExclusiveChild).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(spawn).mock.invocationCallOrder[0]!,
    )
    expect(vi.mocked(spawn).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(finalizeExclusiveChild).mock.invocationCallOrder[0]!,
    )
    expect(finalizeExclusiveChild).toHaveBeenCalledWith({ id: 'reservation-1', path: '/tmp/children' }, 12345)
    expect(vi.mocked(spawn).mock.calls[0]![2]?.env).toMatchObject({
      OPENFOX_CHILD_RESERVATION_ID: 'reservation-1',
    })
  })

  it('refuses to spawn when the reservation cannot be appended', () => {
    vi.mocked(reserveExclusiveChild).mockImplementation(() => {
      throw new Error('append impossible')
    })

    expect(() => spawnShell('sleep 300', { cwd: '/tmp', detached: true })).toThrow(/append impossible/)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('kills the spawned child and fails when finalization cannot be appended', () => {
    vi.mocked(finalizeExclusiveChild).mockImplementation(() => {
      throw new Error('append impossible')
    })

    expect(() => spawnShell('sleep 300', { cwd: '/tmp', detached: true })).toThrow(/track spawned child/)
    expect(killChild).toHaveBeenCalledWith('SIGKILL')
  })
})

describe('spawnShellProcess', () => {
  it('delegates to spawnShell with positional args', () => {
    withPlatform('linux', () => {
      spawnShellProcess('echo hello', '/tmp', undefined, true)
    })

    expect(spawn).toHaveBeenCalledWith(
      '/bin/sh',
      ['-c', 'echo hello'],
      expect.objectContaining({ windowsHide: true, detached: true }),
    )
  })
})
