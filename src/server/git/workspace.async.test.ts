import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { CommandAbortedError, CommandTimeoutError } from '../utils/bounded-exec.js'

const state = vi.hoisted(() => ({ wsRoot: '' }))

vi.mock('../db/projects.js', () => ({
  getProjectByWorkdir: vi.fn(() => ({ workspaceRootDir: state.wsRoot })),
}))

import { deleteWorkspace, ensureWorkspace, WorkspaceDeleteIncompleteError } from './workspace.js'

const PROJECT_NAME = 'async-ws-project'

function timerFiredMs(ms = 20): Promise<number> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    setTimeout(() => resolve(performance.now() - t0), ms)
  })
}

function git(cwd: string, args: string[]): void {
  const env = { ...process.env }
  delete env['GIT_DIR']
  delete env['GIT_INDEX_FILE']
  delete env['GIT_WORK_TREE']
  delete env['GIT_PREFIX']
  execFileSync('git', args, { cwd, env, stdio: 'ignore' })
}

async function makeGitProject(): Promise<{ projectDir: string; wsRoot: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'openfox-ws-async-'))
  const projectDir = join(root, 'project')
  const wsRoot = join(root, 'workspaces')
  await mkdir(projectDir, { recursive: true })
  await mkdir(wsRoot, { recursive: true })
  await writeFile(join(projectDir, 'README.md'), 'hello\n')
  git(projectDir, ['init', '--initial-branch=main'])
  git(projectDir, ['config', 'user.email', 'test@example.com'])
  git(projectDir, ['config', 'user.name', 'Test'])
  git(projectDir, ['add', '-A'])
  git(projectDir, ['commit', '-m', 'init'])
  state.wsRoot = wsRoot
  return {
    projectDir,
    wsRoot,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

async function writeSetup(projectDir: string, setup: string[]): Promise<void> {
  await mkdir(join(projectDir, '.openfox'), { recursive: true })
  await writeFile(join(projectDir, '.openfox', 'workspace.json'), JSON.stringify({ setup }, null, 2))
}

describe('workspace setup and delete (real fs)', () => {
  let ctx: Awaited<ReturnType<typeof makeGitProject>>

  beforeEach(async () => {
    ctx = await makeGitProject()
  })

  afterEach(async () => {
    await ctx?.cleanup()
  })

  it('does not import execSync or spawnSync', async () => {
    const src = await readFile(fileURLToPath(new URL('./workspace.ts', import.meta.url)), 'utf8')
    expect(src).not.toMatch(/\bexecSync\b/)
    expect(src).not.toMatch(/\bspawnSync\b/)
  })

  it('runs a 2s setup command without blocking a 20ms timer', async () => {
    await writeSetup(ctx.projectDir, ['sleep 2'])
    const creating = ensureWorkspace(ctx.projectDir, 'sleepy', PROJECT_NAME)
    await sleep(80)
    const fired = await timerFiredMs(20)
    expect(fired).toBeLessThan(100)
    const result = await creating
    expect(result.name).toBe('sleepy')
  }, 20_000)

  it('kills a setup command and its descendants on abort', async () => {
    const marker = join(ctx.projectDir, 'child.pid')
    const script = [
      `const {spawn}=require('child_process');`,
      `const fs=require('fs');`,
      `const child=spawn('sleep',['30'],{stdio:'ignore'});`,
      `fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
      `setInterval(()=>{},1000);`,
    ].join('')
    await writeSetup(ctx.projectDir, [`${process.execPath} -e ${JSON.stringify(script)}`])
    const ac = new AbortController()
    const creating = ensureWorkspace(ctx.projectDir, 'abort-me', PROJECT_NAME, undefined, undefined, {
      signal: ac.signal,
    })
    const deadline = Date.now() + 4_000
    let childPid = 0
    while (Date.now() < deadline && childPid === 0) {
      try {
        childPid = Number((await readFile(marker, 'utf8')).trim())
      } catch {
        await sleep(30)
      }
    }
    expect(childPid).toBeGreaterThan(0)
    ac.abort()
    await expect(creating).rejects.toBeInstanceOf(CommandAbortedError)
    const deadDeadline = Date.now() + 5_000
    while (Date.now() < deadDeadline) {
      try {
        process.kill(childPid, 0)
        await sleep(50)
      } catch {
        return
      }
    }
    throw new Error(`descendant pid ${childPid} still alive after abort`)
  }, 20_000)

  it('times out a hung setup command', async () => {
    await writeSetup(ctx.projectDir, ['sleep 10'])
    await expect(
      ensureWorkspace(ctx.projectDir, 'timeout-me', PROJECT_NAME, undefined, undefined, { setupTimeoutMs: 250 }),
    ).rejects.toBeInstanceOf(CommandTimeoutError)
  }, 15_000)

  it('deletes a 5000-file tree without blocking a 20ms timer', async () => {
    const created = await ensureWorkspace(ctx.projectDir, 'heavy', PROJECT_NAME)
    const filesDir = join(created.path, 'bulk')
    await mkdir(filesDir, { recursive: true })
    await Promise.all(Array.from({ length: 5_000 }, (_, i) => writeFile(join(filesDir, `f${i}`), 'x')))
    const deleting = deleteWorkspace(PROJECT_NAME, 'heavy', ctx.projectDir)
    await sleep(5)
    const fired = await timerFiredMs(20)
    expect(fired).toBeLessThan(100)
    await deleting
    await expect(readdir(created.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('aborts a 20_000-file delete mid-walk, leaves files, and finishes on retry', async () => {
    const created = await ensureWorkspace(ctx.projectDir, 'partial', PROJECT_NAME)
    const filesDir = join(created.path, 'bulk')
    for (let d = 0; d < 200; d++) {
      const dir = join(filesDir, `d${d}`)
      await mkdir(dir, { recursive: true })
      await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(dir, `f${i}`), 'x')))
    }
    const before = await countFiles(created.path)
    expect(before).toBeGreaterThanOrEqual(20_000)

    const ac = new AbortController()
    const deleting = deleteWorkspace(PROJECT_NAME, 'partial', ctx.projectDir, { signal: ac.signal })
    const waitDeadline = Date.now() + 20_000
    let remaining = before
    while (Date.now() < waitDeadline) {
      remaining = await countFiles(created.path)
      if (remaining > 0 && remaining < before) break
      await sleep(10)
    }
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThan(before)

    const abortAt = performance.now()
    ac.abort()
    await expect(deleting).rejects.toBeInstanceOf(WorkspaceDeleteIncompleteError)
    const abortMs = performance.now() - abortAt
    if (process.platform === 'linux') {
      expect(abortMs, `abort latency ${abortMs} ms`).toBeLessThan(200)
    }

    const afterReject = await countFiles(created.path)
    expect(afterReject).toBeGreaterThan(0)
    await sleep(200)
    const stabilized = await countFiles(created.path)
    expect(stabilized).toBe(afterReject)

    await deleteWorkspace(PROJECT_NAME, 'partial', ctx.projectDir)
    await expect(readdir(created.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)
})

async function countFiles(dir: string): Promise<number> {
  let n = 0
  const walk = async (p: string): Promise<void> => {
    try {
      const entries = await readdir(p, { withFileTypes: true, encoding: 'utf8' })
      for (const entry of entries) {
        const child = join(p, entry.name)
        if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(child)
        else n++
      }
    } catch {
      return
    }
  }
  await walk(dir)
  return n
}
