import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const sshStub = `#!/bin/sh
case "$*" in
  *"/proc/loadavg"*) printf '%s\\n' "\${REMOTE_LOAD:-0.00}" ;;
  *"test -d"*) exit "\${NODE_MODULES_STATUS:-0}" ;;
  *"docker run"*) printf '%s\\n' "$*" >> "$DOCKER_CAPTURE" ;;
esac
exit 0
`

function createBin(dir: string, rsync: string): string {
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'ssh'), sshStub, { mode: 0o700 })
  writeFileSync(join(bin, 'rsync'), rsync, { mode: 0o700 })
  return bin
}

function runScript(dir: string, bin: string, extraEnv: Record<string, string> = {}) {
  return spawnSync('sh', [join(import.meta.dirname, 'test-remote.sh'), '--all'], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH']}`,
      OPENFOX_TEST_HOST: 'test.invalid',
      ...extraEnv,
    },
    encoding: 'utf8',
  })
}

test('remote gates exclude private reports and environment files before transfer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openfox-remote-excludes-'))
  try {
    const capture = join(dir, 'args')
    const bin = createBin(dir, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\nexit 23\n')
    const result = runScript(dir, bin, { CAPTURE: capture })
    expect(result.status).toBe(23)
    const args = readFileSync(capture, 'utf8').trim().split('\n')
    const excludes = args.filter((_, index) => args[index - 1] === '--exclude')
    expect(excludes).toContain('/report/private/')
    expect(excludes).toContain('.env*')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('remote gates refuse an overloaded host before any docker run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openfox-remote-overload-'))
  try {
    const dockerCapture = join(dir, 'docker-runs')
    const bin = createBin(dir, '#!/bin/sh\nexit 0\n')
    const result = runScript(dir, bin, {
      REMOTE_LOAD: '24.01',
      DOCKER_CAPTURE: dockerCapture,
      NODE_MODULES_STATUS: '1',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('1-minute load 24.01 exceeds threshold 24')
    expect(existsSync(dockerCapture)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('remote gates limit both bootstrap and suite containers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openfox-remote-limits-'))
  try {
    const dockerCapture = join(dir, 'docker-runs')
    const bin = createBin(dir, '#!/bin/sh\nexit 0\n')
    const result = runScript(dir, bin, {
      REMOTE_LOAD: '24.00',
      DOCKER_CAPTURE: dockerCapture,
      NODE_MODULES_STATUS: '1',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(
      'test-remote: host=test.invalid load1=24.00 threshold=24 docker_limits=--memory 8g --memory-swap 8g --cpus 8',
    )
    const dockerRuns = readFileSync(dockerCapture, 'utf8').trim().split('\n')
    expect(dockerRuns).toHaveLength(2)
    for (const dockerRun of dockerRuns) {
      expect(dockerRun).toContain('docker run --rm --memory 8g --memory-swap 8g --cpus 8')
    }
    expect(dockerRuns[0]).toContain('npm ci')
    expect(dockerRuns[1]).toContain('npm test')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
