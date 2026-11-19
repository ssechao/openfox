import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

test('remote gates exclude private reports and environment files before transfer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openfox-remote-excludes-'))
  try {
    const bin = join(dir, 'bin')
    const capture = join(dir, 'args')
    mkdirSync(bin)
    writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    writeFileSync(join(bin, 'rsync'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\nexit 23\n', { mode: 0o700 })
    const result = spawnSync('sh', [join(import.meta.dirname, 'test-remote.sh'), '--all'], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env['PATH']}`,
        OPENFOX_TEST_HOST: 'test.invalid',
        CAPTURE: capture,
      },
      encoding: 'utf8',
    })
    expect(result.status).toBe(23)
    const args = readFileSync(capture, 'utf8').trim().split('\n')
    const excludes = args.filter((_, index) => args[index - 1] === '--exclude')
    expect(excludes).toContain('/report/private/')
    expect(excludes).toContain('.env*')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
