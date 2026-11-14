import { describe, expect, it } from 'vitest'
import { createOpenFoxCallerIdentityAuthority, OPENFOX_CALLER_IDENTITY_TTL_MS } from './caller-identity.js'

describe('OpenFox caller identity authority', () => {
  it('issues a proof bound to caller, tool, target, and a 30 second lifetime', () => {
    let now = 1_000
    const authority = createOpenFoxCallerIdentityAuthority({
      secret: Buffer.alloc(32, 7),
      now: () => now,
    })
    const input = {
      callerSessionId: 'caller',
      toolName: 'openfox_delete_session',
      targetSessionId: 'target',
    }
    const proof = authority.issueProof(input)

    expect(authority.verify({ ...input, proof })).toEqual({ ok: true, callerSessionId: 'caller' })
    expect(authority.verify({ ...input, proof })).toEqual({ ok: true, callerSessionId: 'caller' })
    now += OPENFOX_CALLER_IDENTITY_TTL_MS - 1
    expect(authority.verify({ ...input, proof })).toEqual({ ok: true, callerSessionId: 'caller' })
    now += 1
    expect(authority.verify({ ...input, proof })).toEqual({
      ok: false,
      error: 'trusted OpenFox caller identity expired',
    })
  })

  it('rejects malformed, forged, or mismatched proofs without a fallback identity', () => {
    const authority = createOpenFoxCallerIdentityAuthority({
      secret: Buffer.alloc(32, 9),
      now: () => 5_000,
    })
    const input = {
      callerSessionId: 'caller',
      toolName: 'openfox_delete_session',
      targetSessionId: 'target',
    }
    const proof = authority.issueProof(input)
    const [payload, mac] = proof.split('.')

    for (const verification of [
      { ...input, proof: undefined },
      { ...input, proof: 'caller' },
      { ...input, proof: `${payload}.${mac?.slice(0, -1)}x` },
      { ...input, callerSessionId: 'other', proof },
      { ...input, toolName: 'openfox_stop', proof },
      { ...input, targetSessionId: 'other-target', proof },
    ]) {
      expect(authority.verify(verification)).toEqual({
        ok: false,
        error: 'trusted OpenFox caller identity is required',
      })
    }
  })

  it('uses an independent random gateway key by default', () => {
    const first = createOpenFoxCallerIdentityAuthority()
    const second = createOpenFoxCallerIdentityAuthority()
    const input = {
      callerSessionId: 'caller',
      toolName: 'openfox_delete_session',
      targetSessionId: 'target',
    }
    const proof = first.issueProof(input)

    expect(second.verify({ ...input, proof })).toEqual({
      ok: false,
      error: 'trusted OpenFox caller identity is required',
    })
  })
})
