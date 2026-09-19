import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MIN_HEAP_MB, shouldIncreaseHeap } from './heap.js'

const here = dirname(fileURLToPath(import.meta.url))

describe('shouldIncreaseHeap', () => {
  const env = {} as Record<string, string | undefined>

  it('increases heap for the full OpenFox CLI', () => {
    expect(
      shouldIncreaseHeap({
        argv: ['node', 'openfox'],
        execArgv: [],
        env,
      }),
    ).toBe(true)
  })

  it('skips the 6–8 GiB heap bump for openfox remote-agent', () => {
    expect(
      shouldIncreaseHeap({
        argv: ['node', 'openfox', 'remote-agent', '--help'],
        execArgv: [],
        env,
      }),
    ).toBe(false)
    expect(
      shouldIncreaseHeap({
        argv: ['node', 'openfox', 'remote-agent', '--workdir', '/tmp', '--hub-url', 'http://h', '--hub-token', 't'],
        execArgv: [],
        env,
      }),
    ).toBe(false)
  })

  it('skips when the heap is already large enough', () => {
    expect(
      shouldIncreaseHeap({
        argv: ['node', 'openfox'],
        execArgv: [`--max-old-space-size=${MIN_HEAP_MB}`],
        env,
      }),
    ).toBe(false)
  })

  it('skips when OPENFOX_HEAP_INCREASED is set', () => {
    expect(
      shouldIncreaseHeap({
        argv: ['node', 'openfox'],
        execArgv: [],
        env: { OPENFOX_HEAP_INCREASED: '1' },
      }),
    ).toBe(false)
  })
})

describe('openfox CLI entry', () => {
  it('gates the heap respawn on shouldIncreaseHeap', () => {
    const src = readFileSync(join(here, 'index.ts'), 'utf8')
    expect(src).toMatch(/shouldIncreaseHeap/)
    expect(src).toMatch(/from '\.\/heap\.js'/)
  })
})
