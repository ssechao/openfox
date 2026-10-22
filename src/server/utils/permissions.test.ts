import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { runFile } from './bounded-exec.js'
import { checkPermissions, fixPermissions } from './permissions.js'

const actualRunFile = vi.hoisted(() => ({
  current: undefined as unknown as typeof runFile,
}))

vi.mock('./bounded-exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bounded-exec.js')>()
  actualRunFile.current = actual.runFile
  return { ...actual, runFile: vi.fn(actual.runFile) }
})

afterEach(() => {
  vi.mocked(runFile).mockReset()
  vi.mocked(runFile).mockImplementation(actualRunFile.current)
})

describe('permissions', () => {
  it('does not use execSync or spawnSync', async () => {
    const src = await readFile(fileURLToPath(new URL('./permissions.ts', import.meta.url)), 'utf8')
    expect(src).not.toMatch(/\bexecSync\b/)
    expect(src).not.toMatch(/\bspawnSync\b/)
  })

  it('returns 501 on Windows without spawning', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      await expect(checkPermissions('/tmp')).resolves.toMatchObject({ success: false, status: 501 })
      await expect(fixPermissions('/tmp', 'group')).resolves.toMatchObject({ success: false, status: 501 })
      expect(runFile).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })

  it('returns 404 when the path does not exist', async () => {
    if (process.platform === 'win32') return
    const result = await checkPermissions(join(tmpdir(), `openfox-missing-${Date.now()}`))
    expect(result).toMatchObject({ success: false, status: 404, error: 'Path not found' })
  })

  it('checks a real directory without blocking a 20ms timer', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'openfox-perms-'))
    try {
      const pending = checkPermissions(dir)
      await sleep(5)
      const fired = await new Promise<number>((resolve) => {
        const t0 = performance.now()
        setTimeout(() => resolve(performance.now() - t0), 20)
      })
      expect(fired).toBeLessThan(100)
      const result = await pending
      expect(result.success).toBe(true)
      expect(runFile).toHaveBeenCalledWith('id', ['-un'], expect.objectContaining({ timeoutMs: expect.any(Number) }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('passes AbortSignal through and kills the in-flight command', async () => {
    if (process.platform === 'win32') return
    const ac = new AbortController()
    vi.mocked(runFile).mockImplementation((_file, _args, opts) => actualRunFile.current('sleep', ['30'], opts))
    const pending = checkPermissions('/tmp', { signal: ac.signal })
    await sleep(80)
    ac.abort()
    const result = await pending
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/aborted|Command aborted/i)
  }, 15_000)

  it('times out a hung permission command', async () => {
    if (process.platform === 'win32') return
    vi.mocked(runFile).mockImplementation((_file, _args, opts) =>
      actualRunFile.current('sleep', ['30'], { ...opts, timeoutMs: 200 }),
    )
    const started = Date.now()
    const result = await checkPermissions('/tmp')
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/timed out/i)
  }, 15_000)
})
