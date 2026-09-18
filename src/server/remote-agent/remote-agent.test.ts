import { describe, it, expect } from 'vitest'
import {
  AgentIdentity,
  verifyHubSignature,
  canonicalEnvelopePayload,
  agentProofPayload,
  heartbeatProofExtra,
  resultProofExtra,
  freshNonce,
  canonicalCapabilities,
  canonicalBody,
  enrollPayload,
} from './identity.js'
import { createRemoteAgentContext, CONTROL_PLANE_TOOLS, MinimalSessionManager } from './context.js'
import { withRemoteParam, REMOTE_TOOL_NAMES } from './remote-param.js'
import { toSerializedToolResult, fromSerializedToolResult, normalizeHubBase } from './types.js'
import { RemoteAgentDaemon } from './daemon.js'
import { runCommandTool } from '../tools/shell.js'
import { askUserTool } from '../tools/ask.js'
import type { Tool } from '../tools/types.js'

describe('remote-agent identity (Ed25519)', () => {
  it('generates a keypair and signs a nonce', () => {
    const id = AgentIdentity.generate()
    expect(id.publicKeyB64).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const sig = id.sign('hub-nonce-123')
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/)
  })

  it('verifies a signature against the raw public key (hub-side roundtrip)', () => {
    const id = AgentIdentity.generate()
    const msg = 'nonce-abc'
    const sig = id.sign(msg)
    // The hub verifies with the raw 32-byte public key (base64url).
    expect(verifyHubSignature(id.publicKeyB64, msg, sig)).toBe(true)
    expect(verifyHubSignature(id.publicKeyB64, 'other-msg', sig)).toBe(false)
  })

  it('rejects a signature for a different key', () => {
    const a = AgentIdentity.generate()
    const b = AgentIdentity.generate()
    const sig = a.sign('msg')
    expect(verifyHubSignature(b.publicKeyB64, 'msg', sig)).toBe(false)
  })

  it('canonical payload length-prefixes each field (u32 BE)', () => {
    const payload = canonicalEnvelopePayload('req-1', 'agent-1', 'sess-1', 'run_command', '{"a":1}')
    // First field: 4-byte BE length (5) then the raw bytes.
    expect(payload.subarray(0, 4).readUInt32BE(0)).toBe(5)
    expect(payload.subarray(4, 9).toString()).toBe('req-1')
    // Second field: 4-byte BE length (7) then 'agent-1'.
    expect(payload.subarray(9, 13).readUInt32BE(0)).toBe(7)
    expect(payload.subarray(13, 20).toString()).toBe('agent-1')
    expect(payload.toString()).toContain('run_command')
    expect(payload.toString()).toContain('{"a":1}')
  })

  it('freshNonce is timestamped and unique (randomBytes, not Math.random)', () => {
    const before = Date.now()
    const n1 = freshNonce()
    const n2 = freshNonce()
    const after = Date.now()
    const [ts, rand] = n1.split('-')!
    expect(Number(ts)).toBeGreaterThanOrEqual(before)
    expect(Number(ts)).toBeLessThanOrEqual(after)
    // 16 random bytes -> 32 hex chars.
    expect(rand).toMatch(/^[0-9a-f]{32}$/)
    expect(n1).not.toBe(n2)
  })

  it('heartbeat proof binds the full mutable body (tampering fails)', () => {
    const id = AgentIdentity.generate()
    const nonce = freshNonce()
    const extra = heartbeatProofExtra('title', '/work', 'host', '["a","b"]')
    const payload = agentProofPayload('heartbeat', id.publicKeyB64, nonce, 'epoch-1', extra)
    const sig = id.sign(payload)
    expect(verifyHubSignature(id.publicKeyB64, payload, sig)).toBe(true)
    // Tampered title -> invalid.
    const badTitle = agentProofPayload(
      'heartbeat',
      id.publicKeyB64,
      nonce,
      'epoch-1',
      heartbeatProofExtra('other', '/work', 'host', '["a","b"]'),
    )
    expect(verifyHubSignature(id.publicKeyB64, badTitle, sig)).toBe(false)
    // Tampered workdir -> invalid.
    const badWorkdir = agentProofPayload(
      'heartbeat',
      id.publicKeyB64,
      nonce,
      'epoch-1',
      heartbeatProofExtra('title', '/other', 'host', '["a","b"]'),
    )
    expect(verifyHubSignature(id.publicKeyB64, badWorkdir, sig)).toBe(false)
    // Tampered capabilities -> invalid.
    const badCaps = agentProofPayload(
      'heartbeat',
      id.publicKeyB64,
      nonce,
      'epoch-1',
      heartbeatProofExtra('title', '/work', 'host', '["a","b","c"]'),
    )
    expect(verifyHubSignature(id.publicKeyB64, badCaps, sig)).toBe(false)
  })

  it('result proof binds request_id + token + canonical result (tampering fails)', () => {
    const id = AgentIdentity.generate()
    const nonce = freshNonce()
    const extra = resultProofExtra('req-1', 'tok-1', '{"success":true}')
    const payload = agentProofPayload('result', id.publicKeyB64, nonce, 'epoch-1', extra)
    const sig = id.sign(payload)
    expect(verifyHubSignature(id.publicKeyB64, payload, sig)).toBe(true)
    // Tampered request_id -> invalid.
    const badReq = agentProofPayload(
      'result',
      id.publicKeyB64,
      nonce,
      'epoch-1',
      resultProofExtra('req-2', 'tok-1', '{"success":true}'),
    )
    expect(verifyHubSignature(id.publicKeyB64, badReq, sig)).toBe(false)
    // Tampered token -> invalid.
    const badTok = agentProofPayload(
      'result',
      id.publicKeyB64,
      nonce,
      'epoch-1',
      resultProofExtra('req-1', 'tok-2', '{"success":true}'),
    )
    expect(verifyHubSignature(id.publicKeyB64, badTok, sig)).toBe(false)
    // Tampered result -> invalid.
    const badRes = agentProofPayload(
      'result',
      id.publicKeyB64,
      nonce,
      'epoch-1',
      resultProofExtra('req-1', 'tok-1', '{"success":false}'),
    )
    expect(verifyHubSignature(id.publicKeyB64, badRes, sig)).toBe(false)
  })

  it('agent proof payload accepts Buffer extras (byte-for-byte with string extras)', () => {
    const id = AgentIdentity.generate()
    const nonce = freshNonce()
    const asString = agentProofPayload('result', id.publicKeyB64, nonce, 'epoch-1', 'req-1|tok|res')
    const asBuffer = agentProofPayload('result', id.publicKeyB64, nonce, 'epoch-1', Buffer.from('req-1|tok|res'))
    expect(asString.equals(asBuffer)).toBe(true)
    const sig = id.sign(asString)
    expect(verifyHubSignature(id.publicKeyB64, asBuffer, sig)).toBe(true)
  })

  it('agent proof payload preserves non-ASCII extra bytes (Unicode interop)', () => {
    // The hub treats `extra` as raw bytes (&[u8]). A latin1 string round-trip
    // would corrupt `é` (UTF-8 c3 a9) into c3 83 c2 a9. The payload must keep
    // the exact UTF-8 bytes so the signature matches the hub's reconstruction.
    const id = AgentIdentity.generate()
    const nonce = freshNonce()
    const extra = heartbeatProofExtra('titre-é', '/work-é', 'host-é', '["a","b"]')
    // The extra must contain the raw UTF-8 bytes for `é` (c3 a9), NOT the
    // double-encoded c3 83 c2 a9.
    expect(extra.includes(Buffer.from([0xc3, 0xa9]))).toBe(true)
    expect(extra.includes(Buffer.from([0xc3, 0x83, 0xc2, 0xa9]))).toBe(false)
    const payload = agentProofPayload('heartbeat', id.publicKeyB64, nonce, 'epoch-1', extra)
    const sig = id.sign(payload)
    // Reconstructing the payload from the SAME bytes must verify (this is
    // exactly what the hub does: it rebuilds extra from the body fields).
    expect(verifyHubSignature(id.publicKeyB64, payload, sig)).toBe(true)
  })

  it('canonicalBody is injective (no 0x1f delimiter collision)', () => {
    // A naive 0x1f join would collide: ["a","b\x1fc"] == ["a\x1fb","c"].
    // The length-prefix encoding must not.
    const a = canonicalBody(['a', 'b\x1fc'])
    const b = canonicalBody(['a\x1fb', 'c'])
    expect(a.equals(b)).toBe(false)
    expect(canonicalBody(['', 'x']).equals(canonicalBody(['x']))).toBe(false)
    expect(canonicalBody(['x', '']).equals(canonicalBody(['x']))).toBe(false)
    expect(canonicalBody(['ab', 'c']).equals(canonicalBody(['a', 'bc']))).toBe(false)
  })

  it('agent proof payload binds the epoch (restart robustness)', () => {
    const id = AgentIdentity.generate()
    const nonce = freshNonce()
    const payload = agentProofPayload('poll', id.publicKeyB64, nonce, 'epoch-1', '')
    const sig = id.sign(payload)
    expect(verifyHubSignature(id.publicKeyB64, payload, sig)).toBe(true)
    // A proof signed for a DIFFERENT epoch (previous hub process) must not
    // verify against the current-epoch payload.
    const otherEpoch = agentProofPayload('poll', id.publicKeyB64, nonce, 'epoch-2', '')
    expect(verifyHubSignature(id.publicKeyB64, otherEpoch, sig)).toBe(false)
  })

  it('enroll payload binds the epoch (restart robustness for /ra/enroll)', () => {
    const id = AgentIdentity.generate()
    const nonce = freshNonce()
    const caps = canonicalCapabilities(['run_command'])
    const payload = enrollPayload('agent-x', id.publicKeyB64, '/work', 'host', caps, nonce, 'epoch-1')
    const sig = id.sign(payload)
    expect(verifyHubSignature(id.publicKeyB64, payload, sig)).toBe(true)
    // A captured enrollment signed for a DIFFERENT epoch (previous hub
    // process) must not verify against the current-epoch payload: this is
    // what makes /ra/enroll single-use robust across a hub restart (empty
    // nonce cache, nonce still inside the replay window).
    const otherEpoch = enrollPayload('agent-x', id.publicKeyB64, '/work', 'host', caps, nonce, 'epoch-2')
    expect(verifyHubSignature(id.publicKeyB64, otherEpoch, sig)).toBe(false)
    // Tampered metadata still fails.
    const tampered = enrollPayload('agent-y', id.publicKeyB64, '/work', 'host', caps, nonce, 'epoch-1')
    expect(verifyHubSignature(id.publicKeyB64, tampered, sig)).toBe(false)
  })

  it('canonicalCapabilities is sorted and deterministic', () => {
    expect(canonicalCapabilities(['b', 'a', 'c'])).toBe(canonicalCapabilities(['c', 'a', 'b']))
    expect(canonicalCapabilities(['b', 'a', 'c'])).toBe('["a","b","c"]')
  })
})

describe('remote-agent context', () => {
  it('builds a minimal context anchored on the workdir', () => {
    const ctx = createRemoteAgentContext({ workdir: '/tmp/remote-work' })
    expect(ctx.workdir).toBe('/tmp/remote-work')
    expect(ctx.dangerLevel).toBe('dangerous')
    expect(ctx.sessionManager).toBeDefined()
  })

  it('the stub session manager resolves workdir and caches reads', () => {
    const ctx = createRemoteAgentContext({ workdir: '/tmp/remote-work' })
    const sm = ctx.sessionManager as unknown as MinimalSessionManager
    expect(sm.getEffectiveWorkdir('x')).toBe('/tmp/remote-work')
    expect(sm.getProjectWorkdir('x')).toBe('/tmp/remote-work')
    sm.recordFileRead('x', '/tmp/remote-work/a.ts', 'hash-1')
    expect(sm.getReadFiles('x')['/tmp/remote-work/a.ts']?.hash).toBe('hash-1')
  })

  it('control-plane tools are excluded from the daemon', () => {
    expect(CONTROL_PLANE_TOOLS.has('ask_user')).toBe(true)
    expect(CONTROL_PLANE_TOOLS.has('session_metadata')).toBe(true)
    expect(CONTROL_PLANE_TOOLS.has('mcp_config')).toBe(true)
    expect(CONTROL_PLANE_TOOLS.has('call_sub_agent')).toBe(true)
    expect(CONTROL_PLANE_TOOLS.has('workspace')).toBe(true)
    expect(CONTROL_PLANE_TOOLS.has('project_tasks')).toBe(true)
    expect(CONTROL_PLANE_TOOLS.has('step_done')).toBe(true)
    expect(CONTROL_PLANE_TOOLS.has('remote_agents')).toBe(true)
    // Environment tools are NOT excluded.
    expect(CONTROL_PLANE_TOOLS.has('run_command')).toBe(false)
    expect(CONTROL_PLANE_TOOLS.has('read_file')).toBe(false)
    expect(CONTROL_PLANE_TOOLS.has('write_file')).toBe(false)
    expect(CONTROL_PLANE_TOOLS.has('edit_file')).toBe(false)
    expect(CONTROL_PLANE_TOOLS.has('background_process')).toBe(false)
  })
})

describe('remote param injection', () => {
  it('adds the `remote` param to environment tools', () => {
    const tool = withRemoteParam(runCommandTool as Tool)
    const props = (tool.definition.function.parameters as Record<string, unknown>)['properties'] as Record<
      string,
      unknown
    >
    expect(props['remote']).toBeDefined()
    expect((props['remote'] as { type: string }).type).toBe('string')
  })

  it('does not add `remote` to control-plane tools', () => {
    const tool = withRemoteParam(askUserTool as Tool)
    const props = (tool.definition.function.parameters as Record<string, unknown>)['properties'] as Record<
      string,
      unknown
    >
    expect(props['remote']).toBeUndefined()
  })

  it('is idempotent (does not duplicate the param)', () => {
    const once = withRemoteParam(runCommandTool as Tool)
    const twice = withRemoteParam(once)
    expect(twice).toBe(once)
  })

  it('covers the expected environment tool set', () => {
    expect(REMOTE_TOOL_NAMES.has('run_command')).toBe(true)
    expect(REMOTE_TOOL_NAMES.has('read_file')).toBe(true)
    expect(REMOTE_TOOL_NAMES.has('write_file')).toBe(true)
    expect(REMOTE_TOOL_NAMES.has('edit_file')).toBe(true)
    expect(REMOTE_TOOL_NAMES.has('background_process')).toBe(true)
    expect(REMOTE_TOOL_NAMES.has('ask_user')).toBe(false)
    expect(REMOTE_TOOL_NAMES.has('remote_agents')).toBe(false)
  })
})

describe('remote-agent daemon tool exposure', () => {
  it('exposes environment tools and excludes control-plane tools', () => {
    const daemon = new RemoteAgentDaemon({
      workdir: '/tmp/remote-agent-test',
      hubUrl: 'http://127.0.0.1:1/mcp',
      hubToken: 'tok',
    })
    const names = new Set(daemon.toolNames)
    // Environment tools are exposed.
    for (const t of [
      'run_command',
      'read_file',
      'write_file',
      'edit_file',
      'background_process',
      'dev_server',
      'web_fetch',
      'web_search',
      'load_skill',
      'describe_image',
      'return_value',
    ]) {
      expect(names.has(t), `expected ${t} to be exposed`).toBe(true)
    }
    // Control-plane tools are excluded.
    for (const t of [
      'ask_user',
      'session_metadata',
      'mcp_config',
      'call_sub_agent',
      'workspace',
      'project_tasks',
      'step_done',
      'remote_agents',
    ]) {
      expect(names.has(t), `expected ${t} to be excluded`).toBe(false)
    }
  })
})

describe('hub url normalization', () => {
  it('strips a trailing /mcp and trailing slashes', () => {
    expect(normalizeHubBase('http://h:1/mcp')).toBe('http://h:1')
    expect(normalizeHubBase('http://h:1/mcp/')).toBe('http://h:1')
    expect(normalizeHubBase('http://h:1')).toBe('http://h:1')
  })
})

describe('tool result serialization', () => {
  it('roundtrips a successful result', () => {
    const original = { success: true, output: 'hello', durationMs: 42, truncated: false }
    const round = fromSerializedToolResult(toSerializedToolResult(original))
    expect(round.success).toBe(true)
    expect(round.output).toBe('hello')
    expect(round.durationMs).toBe(42)
    expect(round.truncated).toBe(false)
  })

  it('roundtrips an error result', () => {
    const original = { success: false, error: 'boom', durationMs: 0, truncated: false }
    const round = fromSerializedToolResult(toSerializedToolResult(original))
    expect(round.success).toBe(false)
    expect(round.error).toBe('boom')
  })

  it('handles malformed input', () => {
    const round = fromSerializedToolResult('not-an-object')
    expect(round.success).toBe(false)
    expect(round.error).toBeDefined()
  })
})
