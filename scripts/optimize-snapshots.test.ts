import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assertDatabaseIsClosed, createVerifiedBackup, pruneExpiredStorageBackups } from './maintenance-safety.js'

describe('storage maintenance process probe', () => {
  it('continues only when lsof conclusively reports no open process', () => {
    expect(() => assertDatabaseIsClosed({ status: 1, stdout: '', stderr: '' })).not.toThrow()
    expect(() => assertDatabaseIsClosed({ status: 0, stdout: '123\n', stderr: '' })).toThrow(/123/)
    expect(() => assertDatabaseIsClosed({ status: 1, stdout: '', stderr: 'permission denied' })).toThrow(
      /permission denied/,
    )
    expect(() =>
      assertDatabaseIsClosed({
        status: 1,
        stdout: '',
        stderr: '',
        error: new Error('lsof missing'),
      }),
    ).toThrow(/lsof missing/)
    expect(() => assertDatabaseIsClosed({ status: 2, stdout: '', stderr: 'probe failed' })).toThrow(/probe failed/)
  })

  it('aborts before backup when source integrity fails', async () => {
    const backup = vi.fn(async () => undefined)
    const source = { pragma: vi.fn(() => 'corrupt'), backup }
    await expect(createVerifiedBackup(source, '/tmp/backup.db', vi.fn())).rejects.toThrow(/Database integrity/)
    expect(backup).not.toHaveBeenCalled()
  })

  it('surfaces backup creation failures without opening a backup', async () => {
    const openBackup = vi.fn()
    const source = {
      pragma: vi.fn(() => 'ok'),
      backup: vi.fn(async () => {
        throw new Error('disk full')
      }),
    }
    await expect(createVerifiedBackup(source, '/tmp/backup.db', openBackup)).rejects.toThrow(/disk full/)
    expect(openBackup).not.toHaveBeenCalled()
  })

  it('rejects a corrupt backup after closing it', async () => {
    const close = vi.fn()
    const source = { pragma: vi.fn(() => 'ok'), backup: vi.fn(async () => undefined) }
    const openBackup = vi.fn(() => ({ pragma: vi.fn(() => 'corrupt'), close }))
    await expect(createVerifiedBackup(source, '/tmp/backup.db', openBackup)).rejects.toThrow(/Backup integrity/)
    expect(close).toHaveBeenCalledOnce()
  })

  it('prunes only expired timestamped maintenance backups', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openfox-maintenance-backups-'))
    const databasePath = join(directory, 'sessions.db')
    const stale = `${databasePath}.pre-storage-maintenance-1.bak`
    const fresh = `${databasePath}.pre-storage-maintenance-2.bak`
    const unrelated = join(directory, 'other.bak')
    writeFileSync(stale, 'stale')
    writeFileSync(fresh, 'fresh')
    writeFileSync(unrelated, 'other')
    const now = Date.now()
    const old = new Date(now - 11 * 24 * 60 * 60 * 1000)
    utimesSync(stale, old, old)

    expect(pruneExpiredStorageBackups(databasePath, now)).toEqual([stale])
    expect(() => pruneExpiredStorageBackups(databasePath, now)).not.toThrow()
    expect(pruneExpiredStorageBackups(databasePath, now)).toEqual([])
    rmSync(directory, { recursive: true, force: true })
  })
})
