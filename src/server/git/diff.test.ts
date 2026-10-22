import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getGitDiffFiles, formatGitDiffFiles, formatGitReviewDiff, getGitBranch } from './diff.js'
import { setPluginVcsProviders, clearPluginVcsProviders } from '../plugins/vcs-providers.js'
import type { PluginVcsProvider } from '../../plugin/index.js'
import { GIT_QUERY_TIMEOUT_MS } from '../utils/bounded-exec.js'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

vi.mock('./env.js', () => ({
  gitSpawnEnv: () => ({}),
}))

vi.mock('../utils/process-tree.js', () => ({
  terminateProcessTree: vi.fn(),
}))

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { spawn } from 'node:child_process'
import { terminateProcessTree } from '../utils/process-tree.js'
import { logger } from '../utils/logger.js'

type MockProc = {
  stdout: { on: (event: string, cb: (d: Buffer) => void) => void }
  stderr: { on: (event: string, cb: (d: Buffer) => void) => void }
  on: (event: string, cb: (...args: unknown[]) => void) => void
}

function makeMockProc(stdout: string, exitCode = 0): MockProc {
  return {
    stdout: {
      on: (event, cb) => {
        if (event === 'data') setTimeout(() => cb(Buffer.from(stdout)), 0)
      },
    },
    stderr: {
      on: () => {},
    },
    on: (event, cb) => {
      if (event === 'close') setTimeout(() => cb(exitCode), 0)
    },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  clearPluginVcsProviders()
})

describe('formatGitReviewDiff', () => {
  it('includes committed branch changes on a clean working tree', async () => {
    vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
      if (args.join(' ') === 'rev-parse --verify main') {
        return makeMockProc('main-sha\n') as unknown as ReturnType<typeof spawn>
      }
      if (args.join(' ') === 'merge-base HEAD main') {
        return makeMockProc('base-sha\n') as unknown as ReturnType<typeof spawn>
      }
      if (args[0] === 'diff' && args.at(-1) === 'base-sha') {
        return makeMockProc('diff --git a/src/fix.ts b/src/fix.ts\n+committed fix\n') as unknown as ReturnType<
          typeof spawn
        >
      }
      return makeMockProc('', 1) as unknown as ReturnType<typeof spawn>
    }) as typeof spawn)

    const diff = await formatGitReviewDiff('/tmp/project')

    expect(diff).toContain('diff --git a/src/fix.ts b/src/fix.ts')
    expect(diff).toContain('+committed fix')
    expect(vi.mocked(spawn).mock.calls.flatMap((call) => call[1] as string[])).not.toContain('--binary')
  })

  it('caps the total diff and reports omitted files and bytes', async () => {
    const oversized = `diff --git a/src/huge.ts b/src/huge.ts\n${'x'.repeat(240 * 1024)}`
    vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
      if (args.join(' ') === 'rev-parse --verify main') {
        return makeMockProc('main-sha\n') as unknown as ReturnType<typeof spawn>
      }
      if (args.join(' ') === 'merge-base HEAD main') {
        return makeMockProc('base-sha\n') as unknown as ReturnType<typeof spawn>
      }
      if (args[0] === 'diff' && args.at(-1) === 'base-sha') {
        return makeMockProc(oversized) as unknown as ReturnType<typeof spawn>
      }
      return makeMockProc('') as unknown as ReturnType<typeof spawn>
    }) as typeof spawn)

    const diff = await formatGitReviewDiff('/tmp/project')

    expect(Buffer.byteLength(diff)).toBeLessThanOrEqual(200 * 1024)
    expect(diff).toMatch(/Diff truncated: 1 file, \d+ bytes omitted/)
  })

  it('caps each untracked file and represents binary changes without binary patches', async () => {
    const oversized = `diff --git a/huge.txt b/huge.txt\n${'u'.repeat(70 * 1024)}\nUNTRACKED_TAIL`
    vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
      if (args.join(' ') === 'ls-files --others --exclude-standard -z') {
        return makeMockProc('huge.txt\0image.png\0') as unknown as ReturnType<typeof spawn>
      }
      if (args.at(-1) === 'huge.txt') {
        return makeMockProc(oversized, 1) as unknown as ReturnType<typeof spawn>
      }
      if (args.at(-1) === 'image.png') {
        return makeMockProc('Binary files /dev/null and b/image.png differ\n', 1) as unknown as ReturnType<typeof spawn>
      }
      return makeMockProc('', 1) as unknown as ReturnType<typeof spawn>
    }) as typeof spawn)

    const diff = await formatGitReviewDiff('/tmp/project')

    expect(diff).not.toContain('UNTRACKED_TAIL')
    expect(diff).toContain('Binary files /dev/null and b/image.png differ')
    expect(diff).toMatch(/Diff truncated: 1 file, \d+ bytes omitted/)
    const args = vi.mocked(spawn).mock.calls.flatMap((call) => call[1] as string[])
    expect(args).not.toContain('--binary')
    expect(args).toContain('--no-textconv')
  })
})

describe('getGitDiffFiles', () => {
  it('passes --ignore-submodules=none to both git invocations', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockProc('') as unknown as ReturnType<typeof spawn>)
    await getGitDiffFiles('/tmp/project')

    const calls = vi.mocked(spawn).mock.calls
    expect(calls.length).toBe(2)
    for (const call of calls) {
      const args = call[1] as string[]
      expect(args).toContain('--ignore-submodules=none')
    }
  })

  it('spawns git status only after git diff has exited', async () => {
    const order: string[] = []
    vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
      const name = args[0]!
      order.push(`spawn ${name}`)
      const proc = makeMockProc('')
      return {
        ...proc,
        on: (event: string, cb: (...cbArgs: unknown[]) => void) => {
          if (event !== 'close') return
          setTimeout(() => {
            order.push(`close ${name}`)
            cb(0)
          }, 0)
        },
      } as unknown as ReturnType<typeof spawn>
    }) as typeof spawn)

    await getGitDiffFiles('/tmp/project')

    expect(order).toEqual(['spawn diff', 'close diff', 'spawn status', 'close status'])
  })

  it('reports a modified submodule from git diff --name-status output', async () => {
    vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
      const stdout = args[0] === 'diff' ? 'M\tlibs/mod\n' : '?? untracked.txt\n'
      return makeMockProc(stdout) as unknown as ReturnType<typeof spawn>
    }) as typeof spawn)

    const files = await getGitDiffFiles('/tmp/project')

    expect(files).toContainEqual({ path: 'libs/mod', status: 'modified', additions: 0, deletions: 0 })
    expect(files).toContainEqual({ path: 'untracked.txt', status: 'added', additions: 0, deletions: 0 })
  })

  it('delegates to plugin VCS provider when matched', async () => {
    const mockProvider: PluginVcsProvider = {
      id: 'custom-vcs',
      detect: (ctx) => ctx.workdir === '/tmp/multi-project',
      getDiffFiles: async () => [
        { path: 'repo1/file.ts', status: 'modified' },
        { path: 'repo2/other.ts', status: 'added' },
      ],
    }

    setPluginVcsProviders([{ pluginId: 'test-plugin', provider: mockProvider }])

    const files = await getGitDiffFiles('/tmp/multi-project')
    expect(files).toEqual([
      { path: 'repo1/file.ts', status: 'modified', additions: 0, deletions: 0 },
      { path: 'repo2/other.ts', status: 'added', additions: 0, deletions: 0 },
    ])
    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
  })

  it('formats git diff files through VCS provider when matched', async () => {
    const mockProvider: PluginVcsProvider = {
      id: 'custom-vcs',
      detect: () => true,
      getDiffFiles: async () => [{ path: 'pkg/sub.ts', status: 'modified' }],
      formatModifiedFiles: (files) => `Files: ${files.map((f) => f.path).join(', ')}`,
    }

    setPluginVcsProviders([{ pluginId: 'test-plugin', provider: mockProvider }])

    const formatted = await formatGitDiffFiles('/tmp/custom')
    expect(formatted).toBe('Files: pkg/sub.ts')
  })

  it('resolves git branch through VCS provider when matched', async () => {
    const mockProvider: PluginVcsProvider = {
      id: 'custom-vcs',
      detect: () => true,
      getDiffFiles: async () => [],
      getBranch: async () => 'multi (main)',
    }

    setPluginVcsProviders([{ pluginId: 'test-plugin', provider: mockProvider }])

    const branch = await getGitBranch('/tmp/custom')
    expect(branch).toBe('multi (main)')
    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
  })

  it('falls back to native git branch when no VCS provider matches', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockProc('feature-x\n') as unknown as ReturnType<typeof spawn>)

    const branch = await getGitBranch('/tmp/native-repo')
    expect(branch).toBe('feature-x')
    expect(vi.mocked(spawn)).toHaveBeenCalled()
  })
})

describe('git command timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('kills a git that does not answer, logs it, and lets the next call run', async () => {
    const hung = { stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {} }
    vi.mocked(spawn)
      .mockReturnValueOnce(hung as unknown as ReturnType<typeof spawn>)
      .mockReturnValue(makeMockProc('main\n') as unknown as ReturnType<typeof spawn>)
    vi.mocked(terminateProcessTree).mockResolvedValue()
    vi.useFakeTimers()

    let settled = false
    const first = getGitBranch('/tmp/hung').finally(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(GIT_QUERY_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    expect(terminateProcessTree).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await expect(first).resolves.toBeNull()
    expect(terminateProcessTree).toHaveBeenCalledWith(hung)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('timed out'),
      expect.objectContaining({
        cwd: '/tmp/hung',
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        timeoutMs: GIT_QUERY_TIMEOUT_MS,
      }),
    )

    vi.useRealTimers()
    await expect(getGitBranch('/tmp/hung')).resolves.toBe('main')
  })
})
