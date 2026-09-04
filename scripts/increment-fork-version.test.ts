import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { incrementForkVersion, nextForkVersion } from './increment-fork-version.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('fork build version', () => {
  it('initializes and increments the fork prerelease number', () => {
    expect(nextForkVersion('2.0.135')).toBe('2.0.135-fork.0')
    expect(nextForkVersion('2.0.135-fork')).toBe('2.0.135-fork.0')
    expect(nextForkVersion('2.0.135-fork.0')).toBe('2.0.135-fork.1')
    expect(nextForkVersion('2.0.135-fork.41')).toBe('2.0.135-fork.42')
  })

  it('rejects unrelated prerelease formats', () => {
    expect(() => nextForkVersion('2.0.135-beta.1')).toThrow(/Unsupported version/)
  })

  it('updates package.json and both package-lock version fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openfox-fork-version-'))
    directories.push(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'openfox', version: '2.0.135-fork.7' }))
    await writeFile(
      join(directory, 'package-lock.json'),
      JSON.stringify({ name: 'openfox', version: '2.0.135-fork.7', packages: { '': { version: '2.0.135-fork.7' } } }),
    )

    expect(await incrementForkVersion(directory)).toBe('2.0.135-fork.8')

    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { version: string }
    const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8')) as {
      version: string
      packages: Record<string, { version: string }>
    }
    expect(pkg.version).toBe('2.0.135-fork.8')
    expect(lock.version).toBe('2.0.135-fork.8')
    expect(lock.packages['']?.version).toBe('2.0.135-fork.8')
  })
})
