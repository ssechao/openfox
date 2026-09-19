import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const installer = join(here, 'install-remote-agent.sh')
const workflow = join(repoRoot, '.github/workflows/release-remote-agent.yml')
const docs = join(repoRoot, 'docs/REMOTE-AGENT.md')
const buildScript = join(here, 'build-remote-agent.sh')
const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

describe('release-remote-agent workflow', () => {
  it('builds four targets on ubuntu-22.04 glibc, not ubuntu-latest or musl', () => {
    const yml = readFileSync(workflow, 'utf8')
    expect(yml).toMatch(/remote-agent-v\*/)
    expect(yml).toMatch(/workflow_dispatch/)
    expect(yml).toMatch(/ubuntu-22\.04/)
    expect(yml).not.toMatch(/ubuntu-latest/)
    expect(yml).toContain('remote-agent-linux-x64')
    expect(yml).toContain('remote-agent-linux-arm64')
    expect(yml).toContain('remote-agent-darwin-arm64')
    expect(yml).toContain('remote-agent-darwin-x64')
    expect(yml).toContain('bun-linux-x64')
    expect(yml).toContain('bun-linux-arm64')
    expect(yml).not.toMatch(/musl/)
    expect(yml).toMatch(/--help/)
    expect(yml).toMatch(/--version/)
    expect(yml).toMatch(/file_re:/)
    expect(yml).toContain('ELF 64-bit LSB .*x86-64')
    expect(yml).toContain('ELF 64-bit LSB .*aarch64')
    expect(yml).toContain('Mach-O 64-bit executable arm64')
    expect(yml).toContain('Mach-O 64-bit executable x86_64')
    expect(yml).toMatch(/lipo -archs/)
    expect(yml).toMatch(/name: Assert binary architecture\n {8}run:/)
    expect(yml).not.toMatch(/name: Assert binary architecture\n {8}if:/)
  })

  it('compiles via scripts/build-remote-agent.sh', () => {
    const sh = readFileSync(buildScript, 'utf8')
    expect(sh).toMatch(/bun build --compile/)
    expect(sh).toMatch(/remote-agent-bin\.ts/)
    expect(sh).toMatch(/OPENFOX_RA_VERSION/)
    expect(sh).not.toMatch(/--external better-sqlite3/)
    expect(readFileSync(workflow, 'utf8')).toContain('scripts/build-remote-agent.sh')
  })
})

describe('install-remote-agent.sh', () => {
  it('is non-interactive and contains no hub tokens', () => {
    const sh = readFileSync(installer, 'utf8')
    expect(sh).not.toMatch(/\bread -[a-zA-Z]*r/)
    expect(sh).not.toMatch(/\/dev\/tty/)
    expect(sh).not.toMatch(/AETHER_RA_CONTROL_TOKEN|hub-token|192\.168\.71\.132|:4175/)
    expect(sh).toContain('ssechao/openfox')
    expect(sh).toContain('.local/bin')
    expect(sh).toContain('/usr/local/bin')
    expect(sh).toMatch(/id -u/)
    expect(sh).toMatch(/Run: \$\{dest\} --help/)
    expect(sh).not.toMatch(/Run: remote-agent --help/)
  })

  it.skipIf(process.platform === 'win32')('installs to REMOTE_AGENT_INSTALL_DIR and prints the full path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-install-'))
    homes.push(home)
    const fake = '#!/bin/sh\necho remote-agent-mock\n'
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(fake)
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    try {
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('no listen port')
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn('sh', [installer], {
          env: {
            ...process.env,
            HOME: home,
            REMOTE_AGENT_INSTALL_DIR: join(home, 'opt/bin'),
            REMOTE_AGENT_BASE_URL: `http://127.0.0.1:${addr.port}`,
          },
        })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`installer timed out\n${stdout}\n${stderr}`))
        }, 10_000)
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        child.on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.on('close', (status) => {
          clearTimeout(timer)
          resolve({ status, stdout, stderr })
        })
      })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const dest = join(home, 'opt/bin/remote-agent')
      expect(existsSync(dest)).toBe(true)
      chmodSync(dest, 0o755)
      const help = spawnSync(dest, ['--help'], { encoding: 'utf8' })
      expect(help.status).toBe(0)
      expect(result.stdout).toContain(`Installed ${dest}`)
      expect(result.stdout).toContain(`Run: ${dest} --help`)
      expect(result.stdout + result.stderr).not.toMatch(/\[y\/N\]|overwrite/i)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('REMOTE-AGENT.md installer docs', () => {
  it('documents the raw.githubusercontent.com curl | sh line', () => {
    const md = readFileSync(docs, 'utf8')
    expect(md).toContain(
      'curl -fsSL https://raw.githubusercontent.com/ssechao/openfox/main/scripts/install-remote-agent.sh | sh',
    )
    expect(md).toContain('~/.local/bin/remote-agent --help')
    expect(md).toContain('/usr/local/bin/remote-agent --help')
  })
})

describe('slim-bin packaging surface', () => {
  it('does not tsup-bundle remote-agent-bin (bun compiles from TS)', () => {
    const tsup = readFileSync(join(repoRoot, 'tsup.config.ts'), 'utf8')
    expect(tsup).not.toMatch(/remote-agent-bin/)
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { bin?: Record<string, string> }
    expect(pkg.bin?.['remote-agent']).toBeUndefined()
  })

  it('ignores bun compile leftovers', () => {
    const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8')
    expect(gitignore).toMatch(/^\*\.bun-build$/m)
  })
})
