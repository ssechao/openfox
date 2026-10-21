import { describe, expect, it } from 'vitest'
import { InstanceLockError, instanceLockRefusalTx } from '../server/db/instance-lock.js'
import { cliT, setCliMode } from './i18n.js'

describe('instance lock CLI message', () => {
  it('prints the English refusal by default, with path and PID', () => {
    setCliMode('test')
    const error = new InstanceLockError('/tmp/sessions.db', {
      pid: 4242,
      startedAt: '2026-10-21T00:00:00.000Z',
    })
    const line = cliT(instanceLockRefusalTx(error))
    expect(line).toMatch(/database already in use by instance PID 4242/)
    expect(line).toContain('/tmp/sessions.db')
    expect(line).toMatch(/stop PID 4242/)
    expect(line.split('\n')).toHaveLength(1)
  })
})
