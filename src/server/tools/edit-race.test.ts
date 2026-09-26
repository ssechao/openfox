import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { editFileTool } from './edit.js'
import type { ToolContext } from './types.js'
import type { SessionManager } from '../session/manager.js'
import type { LspManagerInterface } from '../lsp/types.js'
import type { Diagnostic } from '../../shared/types.js'

function hashFile(filePath: string): string {
  const content = readFileSync(filePath)
  return createHash('sha256').update(content).digest('hex')
}

describe('edit_file parallel race condition', () => {
  let tmpDir: string
  let filePath: string
  let fileHashes: Record<string, { hash: string; readAt: string }>

  function createContext(): ToolContext {
    return {
      workdir: tmpDir,
      sessionId: 'test-session',
      sessionManager: {
        getReadFiles: () => fileHashes,
        updateFileHash: (_sessionId: string, path: string) => {
          fileHashes[path] = { hash: hashFile(path), readAt: new Date().toISOString() }
        },
        requireSession: () => ({ id: 'test-session', workdir: tmpDir }),
      } as unknown as SessionManager,
    }
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'edit-race-test-'))
    filePath = join(tmpDir, 'test.txt')

    writeFileSync(
      filePath,
      [
        '// line 1',
        'const a = "old_value_a"',
        '// line 3',
        'const b = "old_value_b"',
        '// line 5',
        'const c = "old_value_c"',
        '// line 7',
        'const d = "old_value_d"',
        '// line 9',
        'const e = "old_value_e"',
        '',
      ].join('\n'),
      'utf-8',
    )

    fileHashes = {
      [filePath]: { hash: hashFile(filePath), readAt: new Date().toISOString() },
    }
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('applies all edits when called sequentially', async () => {
    const context = createContext()

    const r1 = await editFileTool.execute(
      { path: filePath, old_string: 'const a = "old_value_a"', new_string: 'const a = "new_value_a"' },
      context,
    )
    expect(r1.success).toBe(true)

    const r2 = await editFileTool.execute(
      { path: filePath, old_string: 'const b = "old_value_b"', new_string: 'const b = "new_value_b"' },
      context,
    )
    expect(r2.success).toBe(true)

    const r3 = await editFileTool.execute(
      { path: filePath, old_string: 'const c = "old_value_c"', new_string: 'const c = "new_value_c"' },
      context,
    )
    expect(r3.success).toBe(true)

    const content = readFileSync(filePath, 'utf-8')
    expect(content).toContain('const a = "new_value_a"')
    expect(content).toContain('const b = "new_value_b"')
    expect(content).toContain('const c = "new_value_c"')
  })

  it('drops edits when called in parallel on the same file', async () => {
    const context = createContext()

    const results = await Promise.all([
      editFileTool.execute(
        { path: filePath, old_string: 'const a = "old_value_a"', new_string: 'const a = "new_value_a"' },
        context,
      ),
      editFileTool.execute(
        { path: filePath, old_string: 'const b = "old_value_b"', new_string: 'const b = "new_value_b"' },
        context,
      ),
      editFileTool.execute(
        { path: filePath, old_string: 'const c = "old_value_c"', new_string: 'const c = "new_value_c"' },
        context,
      ),
    ])

    for (const r of results) {
      expect(r.success).toBe(true)
    }

    const content = readFileSync(filePath, 'utf-8')

    const aApplied = content.includes('const a = "new_value_a"')
    const bApplied = content.includes('const b = "new_value_b"')
    const cApplied = content.includes('const c = "new_value_c"')
    const totalApplied = [aApplied, bApplied, cApplied].filter(Boolean).length

    // All 3 parallel edits should be applied (no race condition)
    expect(totalApplied).toBe(3)
  })

  it('waits for LSP diagnostics only on the last edit of a same-file batch', async () => {
    const waitCalls: boolean[] = []
    const lspManager = {
      async notifyFileChange(_path: string, _content: string, awaitDiagnostics = true) {
        waitCalls.push(awaitDiagnostics)
        if (awaitDiagnostics) {
          // Simulate a slow language server round-trip.
          await new Promise((resolve) => setTimeout(resolve, 60))
          return [
            {
              path: _path,
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
              severity: 'error',
              message: 'mock diagnostic',
              source: 'mock-lsp',
            } as Diagnostic,
          ]
        }
        return []
      },
      getDiagnostics: () => [],
      isAvailableFor: () => true,
      getInstallHint: () => null,
    } as unknown as LspManagerInterface

    const context: ToolContext = { ...createContext(), lspManager }
    const results = await Promise.all([
      editFileTool.execute(
        { path: filePath, old_string: 'const a = "old_value_a"', new_string: 'const a = "new_value_a"' },
        context,
      ),
      editFileTool.execute(
        { path: filePath, old_string: 'const b = "old_value_b"', new_string: 'const b = "new_value_b"' },
        context,
      ),
    ])

    for (const r of results) {
      expect(r.success).toBe(true)
    }

    // Both edits still notify the LSP (document stays in sync)…
    expect(waitCalls).toHaveLength(2)
    // …but only the last edit in the queue blocks on the (slow) diagnostics
    // round-trip — exactly one awaitDiagnostics=true instead of two.
    expect(waitCalls).toEqual([false, true])
  })
})
