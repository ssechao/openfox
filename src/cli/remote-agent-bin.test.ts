import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runRemoteAgentBin } from './remote-agent-entry.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../..')
const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')
const binFile = join(here, 'remote-agent-bin.ts')
const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

function listDbFiles(root: string): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (!dir) continue
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        stack.push(path)
      } else if (entry.name === 'sessions.db' || entry.name.endsWith('.db')) {
        out.push(path)
      }
    }
  }
  return out
}

function spawnSlim(args: string[], home: string) {
  return spawnSync(process.execPath, [tsxCli, binFile, ...args], {
    cwd: home,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      HOME: home,
      OPENFOX_MODE: 'test',
    },
  })
}

describe('slim remote-agent entry', () => {
  it('does not bump heap or open sqlite in the source graph of --help', () => {
    const binSrc = readFileSync(join(here, 'remote-agent-bin.ts'), 'utf8')
    const entrySrc = readFileSync(join(here, 'remote-agent-entry.ts'), 'utf8')
    expect(binSrc).not.toMatch(/max-old-space|MIN_HEAP|sessions\.db|better-sqlite3/)
    expect(entrySrc).not.toMatch(/max-old-space|MIN_HEAP|sessions\.db|better-sqlite3/)
    expect(entrySrc).toMatch(/await import\('\.\/remote-agent\.js'\)/)
  })

  it('--help returns 0 and lists daemon flags', async () => {
    const lines: string[] = []
    const spy = viConsole((m) => lines.push(m))
    const code = await runRemoteAgentBin(['--help'])
    spy()
    expect(code).toBe(0)
    const text = lines.join('\n')
    expect(text).toContain('--workdir')
    expect(text).toContain('--hub-url')
    expect(text).toContain('--hub-token')
    expect(text).toContain('--name')
    expect(text).toContain('--mcp-config')
    expect(text).toContain('healthz')
    expect(text).toMatch(/Usage:\n {2}remote-agent --workdir/)
    expect(text).not.toMatch(/Usage:\n {2}openfox remote-agent --workdir/)
  })

  it('rejects add/remove/--print-config without writing OpenFox config', async () => {
    const lines: string[] = []
    const spy = viConsole((m) => lines.push(m))
    const add = await runRemoteAgentBin(['add', '--hub-url', 'http://h', '--hub-token', 't'])
    const remove = await runRemoteAgentBin(['remove'])
    const printConfig = await runRemoteAgentBin(['--print-config'])
    spy()
    expect(add).toBe(1)
    expect(remove).toBe(1)
    expect(printConfig).toBe(1)
    const text = lines.join('\n')
    expect(text).toMatch(/openfox remote-agent/)
    expect(text).not.toMatch(/Restart the OpenFox server/)
  })

  it('--version returns 0', async () => {
    const restore = viConsole(() => undefined)
    const code = await runRemoteAgentBin(['--version'])
    restore()
    expect(code).toBe(0)
  })

  it('missing daemon flags return 1 without starting the daemon', async () => {
    const restore = viConsole(() => undefined)
    const code = await runRemoteAgentBin([])
    restore()
    expect(code).toBe(1)
  })
})

describe('slim remote-agent process', () => {
  it('--help exits 0 without creating sessions.db', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-slim-help-'))
    homes.push(home)
    const result = spawnSlim(['--help'], home)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('--workdir')
    expect(result.stdout).toContain('--hub-url')
    expect(result.stdout).toContain('healthz')
    expect(listDbFiles(home)).toEqual([])
  })

  it('--version exits 0 without creating sessions.db', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-slim-ver-'))
    homes.push(home)
    const result = spawnSlim(['--version'], home)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim().length).toBeGreaterThan(0)
    expect(listDbFiles(home)).toEqual([])
  })

  it('openfox remote-agent --help does not open sessions.db or serve', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-openfox-help-'))
    homes.push(home)
    const result = spawnSync(process.execPath, [tsxCli, join(here, 'index.ts'), 'remote-agent', '--help'], {
      cwd: home,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        HOME: home,
        OPENFOX_MODE: 'test',
      },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('--workdir')
    expect(result.stdout).toContain('healthz')
    expect(result.stdout).toContain('openfox remote-agent add')
    expect(result.stdout).toContain('--control-token')
    expect(result.stdout).toMatch(/Usage:\n {2}openfox remote-agent --workdir/)
    expect(result.stdout).not.toMatch(/Usage:\n {2}remote-agent --workdir/)
    expect(listDbFiles(home)).toEqual([])
  })

  it('slim binary add/remove/--print-config exit 1 without writing config', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-slim-add-'))
    homes.push(home)
    for (const args of [['add', '--hub-url', 'http://h', '--hub-token', 't'], ['remove'], ['--print-config']]) {
      const result = spawnSlim(args, home)
      expect(result.status, result.stderr).toBe(1)
      expect(result.stdout + result.stderr).toMatch(/openfox remote-agent/)
      expect(result.stdout + result.stderr).not.toMatch(/Restart the OpenFox server/)
    }
    expect(existsSync(join(home, 'Library', 'Application Support', 'openfox'))).toBe(false)
    expect(existsSync(join(home, '.config', 'openfox'))).toBe(false)
    expect(existsSync(join(home, 'e2e', '.openfox-test'))).toBe(false)
  })
})

function viConsole(impl: (message: string) => void): () => void {
  const log = (...args: unknown[]) => impl(args.map(String).join(' '))
  const origLog = console.log
  const origErr = console.error
  console.log = log as typeof console.log
  console.error = log as typeof console.error
  return () => {
    console.log = origLog
    console.error = origErr
  }
}
