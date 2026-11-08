import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureExclusiveProcessInventory, captureExclusiveProcessInventoryAsync } from './children.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('worker inventory capture', () => {
  it('does not record an error when the worker process is already gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openfox-inventory-'))
    roots.push(root)
    const path = join(root, 'children.jsonl')
    await writeFile(path, '')

    const inventory = captureExclusiveProcessInventory(42, path, {
      readInventory: () => ({ status: 'absent' }),
      findReservationPids: () => [],
      readGroup: () => ({ status: 'absent' }),
      now: () => 1,
    })

    expect(inventory.errors).toEqual([])
    expect(inventory.worker).toBeUndefined()
  })
})

describe('reservation inventory scan', () => {
  it('does not record a timeout when the process scan finishes after the short read budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openfox-inventory-'))
    roots.push(root)
    const path = join(root, 'children.jsonl')
    await writeFile(path, `${JSON.stringify({ type: 'reservation', id: 'r1', command: 'printf x' })}\n`)

    const inventory = await captureExclusiveProcessInventoryAsync(1, path, {
      recordedWorker: { pid: 1, startedAt: 't0', pgid: 1 },
      readInventory: () => ({ status: 'absent' }),
      findReservationPids: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400))
        return []
      },
    })

    expect(inventory.errors, 'reservation inventory scan timed out').toEqual([])
    expect(inventory.reservations).toEqual([{ id: 'r1', command: 'printf x', finalized: false, processes: [] }])
  })
})
