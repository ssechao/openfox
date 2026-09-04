import { describe, expect, it } from 'vitest'
import { assertDatabaseIsClosed } from './maintenance-safety.js'

describe('storage maintenance process probe', () => {
  it('continues only when lsof conclusively reports no open process', () => {
    expect(() => assertDatabaseIsClosed({ status: 1, stdout: '', stderr: '' })).not.toThrow()
    expect(() => assertDatabaseIsClosed({ status: 0, stdout: '123\n', stderr: '' })).toThrow(/123/)
    expect(() => assertDatabaseIsClosed({ status: 2, stdout: '', stderr: 'probe failed' })).toThrow(/probe failed/)
    expect(() =>
      assertDatabaseIsClosed({ status: null, stdout: '', stderr: '', error: new Error('lsof missing') }),
    ).toThrow(/lsof missing/)
  })
})
