import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeLiveEditContext, LiveEditContextTracker } from './edit-file-preview.js'

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'edit-preview-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const FILE = ['line one', 'line two', 'line three', 'const x = 1;', 'line five', 'line six', 'line seven'].join('\n')

describe('computeLiveEditContext', () => {
  it('returns undefined when there is no arguments fragment', async () => {
    await withTempDir(async (dir) => {
      expect(await computeLiveEditContext(undefined, dir, new Map())).toBeUndefined()
      expect(await computeLiveEditContext('', dir, new Map())).toBeUndefined()
    })
  })

  it('returns undefined when the path or edit strings are missing', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.ts'), FILE)
      expect(await computeLiveEditContext('{"path":"a.ts"', dir, new Map())).toBeUndefined()
    })
  })

  it('returns undefined when the file does not exist', async () => {
    await withTempDir(async (dir) => {
      const result = await computeLiveEditContext(
        '{"path":"missing.ts","old_string":"x","new_string":"y"}',
        dir,
        new Map(),
      )
      expect(result).toBeUndefined()
    })
  })

  it('computes regions with surrounding context for a matching edit', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.ts'), FILE)
      const regions = await computeLiveEditContext(
        '{"path":"a.ts","old_string":"const x = 1;","new_string":"const x = 2;"}',
        dir,
        new Map(),
      )
      expect(regions).toBeDefined()
      expect(regions!.length).toBe(1)
      const region = regions![0]!
      expect(region.oldContent).toBe('const x = 1;')
      expect(region.newContent).toBe('const x = 2;')
      expect(region.beforeContext.at(-1)?.content).toBe('line three')
      expect(region.afterContext[0]?.content).toBe('line five')
    })
  })

  it('returns undefined when the edit does not match the file', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.ts'), FILE)
      const regions = await computeLiveEditContext(
        '{"path":"a.ts","old_string":"not present","new_string":"y"}',
        dir,
        new Map(),
      )
      expect(regions).toBeUndefined()
    })
  })

  it('reads the file only once per path', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.ts'), FILE)
      const cache = new Map<string, string>()
      const first = await computeLiveEditContext(
        '{"path":"a.ts","old_string":"const x = 1;","new_string":"a"}',
        dir,
        cache,
      )
      // Simulate the file changing on disk — the cache must shield the second call.
      await writeFile(join(dir, 'a.ts'), 'changed content')
      const second = await computeLiveEditContext(
        '{"path":"a.ts","old_string":"changed content","new_string":"b"}',
        dir,
        cache,
      )
      expect(first).toBeDefined()
      // Cached content is the original, so "changed content" does not match.
      expect(second).toBeUndefined()
    })
  })

  it('supports replace_all producing merged regions', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, 'src'))
      const content = ['a = 1', 'b = 2', 'a = 3', 'c = 4', 'a = 5', 'd = 6'].join('\n')
      await writeFile(join(dir, 'src', 'x.ts'), content)
      const regions = await computeLiveEditContext(
        '{"path":"src/x.ts","old_string":"a = ","new_string":"b = ","replace_all":true}',
        dir,
        new Map(),
      )
      expect(regions).toBeDefined()
      expect(regions!.length).toBeGreaterThanOrEqual(1)
      expect(regions![0]!.edits.length).toBe(3)
    })
  })
})

describe('LiveEditContextTracker', () => {
  // Fake "compute" that mirrors the shape of computeLiveEditContext: regions
  // only exist once old_string matches the (real) content, and newContent
  // tracks the streamed new_string.
  function fakeCompute() {
    const compute = vi.fn(async (fragment?: string) => {
      const parsed = JSON.parse(fragment ?? '{}') as { old_string?: string; new_string?: string }
      if (parsed.old_string !== 'const x = 1;') return undefined
      return [
        {
          startLine: 1,
          endLine: 1,
          beforeContext: [],
          afterContext: [],
          oldContent: parsed.old_string,
          newContent: parsed.new_string ?? '',
          edits: [],
        },
      ]
    })
    return compute
  }

  it('does not recompute or re-emit when the edit spec is unchanged', async () => {
    const compute = fakeCompute()
    const tracker = new LiveEditContextTracker()
    const cache = new Map<string, string>()
    const fragment = '{"path":"a.ts","old_string":"const x = 1;","new_string":"const x = 2;"}'

    const first = await tracker.next(0, fragment, 'workdir', cache, compute)
    expect(first).toBeDefined()
    expect(compute).toHaveBeenCalledTimes(1)

    // Identical chunk again (e.g. the LLM re-sends the same accumulated args):
    // no recompute, no redundant editContext payload.
    const second = await tracker.next(0, fragment, 'workdir', cache, compute)
    expect(second).toBeUndefined()
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('recomputes when new_string grows but still emits the live replacement', async () => {
    const compute = fakeCompute()
    const tracker = new LiveEditContextTracker()
    const cache = new Map<string, string>()

    const first = await tracker.next(
      0,
      '{"path":"a.ts","old_string":"const x = 1;","new_string":"a"}',
      'w',
      cache,
      compute,
    )
    expect(first).toBeDefined()

    const second = await tracker.next(
      0,
      '{"path":"a.ts","old_string":"const x = 1;","new_string":"ab"}',
      'w',
      cache,
      compute,
    )
    expect(compute).toHaveBeenCalledTimes(2)
    expect(second).toBeDefined()
    expect(second![0]!.newContent).toBe('ab')
  })

  it('emits nothing until the edit matches, then recovers when old_string changes', async () => {
    const compute = fakeCompute()
    const tracker = new LiveEditContextTracker()
    const cache = new Map<string, string>()

    // Incomplete old_string: no match yet.
    expect(await tracker.next(0, '{"path":"a.ts","old_string":"const"}', 'w', cache, compute)).toBeUndefined()
    // Old_string grows to a complete (matching) form -> regions emitted.
    const matched = await tracker.next(
      0,
      '{"path":"a.ts","old_string":"const x = 1;","new_string":"b"}',
      'w',
      cache,
      compute,
    )
    expect(matched).toBeDefined()
    // Old_string changes to something that no longer matches -> regions drop.
    expect(
      await tracker.next(0, '{"path":"a.ts","old_string":"const x = 9;","new_string":"c"}', 'w', cache, compute),
    ).toBeUndefined()
    // Old_string comes back to the exact previously-matched edit: the preview
    // must re-emit (a dropped match must reset the last-emitted dedupe state).
    const rematch = await tracker.next(
      0,
      '{"path":"a.ts","old_string":"const x = 1;","new_string":"b"}',
      'w',
      cache,
      compute,
    )
    expect(rematch).toBeDefined()
  })
})
