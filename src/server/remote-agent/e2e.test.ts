import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteAgentDaemon } from './daemon.js'
import { HubClient } from './client.js'
import { AgentIdentity, agentProofPayload, heartbeatProofExtra, canonicalCapabilities, freshNonce } from './identity.js'

/**
 * End-to-end integration: real Rust hub (subprocess) + real headless-agent
 * daemon (in-process) + real HubClient. Proves the full loop:
 * enroll -> heartbeat -> list -> execute(run_command) -> execute(write/read/edit).
 *
 * The hub binary path is provided via E2E_HUB_BIN (cargo build output). The
 * test is skipped when it is not set (e.g. on a machine without the Rust toolchain).
 */
const HUB_BIN = process.env['E2E_HUB_BIN']

describe('remote-agent e2e (hub + daemon + client)', () => {
  if (!HUB_BIN) {
    it('skips when E2E_HUB_BIN is not set', () => {
      expect(true).toBe(true)
    })
    return
  }

  let hub: ChildProcess
  let daemon: RemoteAgentDaemon
  let client: HubClient
  let workdir: string
  let hubPort: number
  const HUB_TOKEN = 'e2e-hub-token'
  const CONTROL_TOKEN = 'e2e-control-token'

  beforeAll(async () => {
    // realpath: on macOS /var is a symlink to /private/var, and `pwd` (and the
    // daemon's resolved workdir) report the real path. Normalize up front so
    // comparisons are stable.
    workdir = realpathSync(mkdtempSync(join(tmpdir(), 'remote-agent-e2e-')))
    // Find a free port.
    const net = await import('node:net')
    hubPort = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer()
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        if (addr && typeof addr === 'object') resolve(addr.port)
        else reject(new Error('no port'))
        srv.close(() => undefined)
      })
      srv.on('error', reject)
    })
    hub = spawn(HUB_BIN, ['--transport', 'http', '--http-port', String(hubPort), '--http-bind', '127.0.0.1'], {
      env: { ...process.env, AETHER_HUB_TOKEN: HUB_TOKEN, AETHER_RA_CONTROL_TOKEN: CONTROL_TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Wait for the hub to listen.
    await new Promise<void>((resolve, reject) => {
      const started = Date.now()
      const check = async () => {
        try {
          await fetch(`http://127.0.0.1:${hubPort}/mcp`, { method: 'GET' })
          resolve()
        } catch {
          if (Date.now() - started > 15000) reject(new Error('hub did not start'))
          else setTimeout(check, 200)
        }
      }
      check()
    })

    daemon = new RemoteAgentDaemon({
      workdir,
      hubUrl: `http://127.0.0.1:${hubPort}/mcp`,
      hubToken: HUB_TOKEN,
      name: 'e2e-agent',
      pollIntervalMs: 200,
      heartbeatIntervalMs: 2000,
      callTimeoutMs: 15000,
    })
    await daemon.start()

    client = new HubClient({
      hubUrl: `http://127.0.0.1:${hubPort}/mcp`,
      hubToken: HUB_TOKEN,
      controlToken: CONTROL_TOKEN,
      callTimeoutMs: 15000,
    })

    // Wait for the agent to enroll and appear.
    await new Promise<void>((resolve, reject) => {
      const started = Date.now()
      const check = async () => {
        const agents = await client.listAgents().catch(() => [])
        if (agents.some((a) => a.title === 'e2e-agent' && a.alive)) resolve()
        else if (Date.now() - started > 10000) reject(new Error('agent did not enroll'))
        else setTimeout(check, 200)
      }
      check()
    })
  }, 30000)

  afterAll(async () => {
    await daemon?.stop()
    hub?.kill('SIGTERM')
    if (workdir && existsSync(workdir)) rmSync(workdir, { recursive: true, force: true })
  })

  it('lists the enrolled agent with its workdir', async () => {
    const agents = await client.listAgents()
    const agent = agents.find((a) => a.title === 'e2e-agent')
    expect(agent).toBeDefined()
    expect(agent!.workdir).toBe(workdir)
    expect(agent!.alive).toBe(true)
  })

  it('executes run_command on the remote (pwd = remote workdir)', async () => {
    const result = await client.executeTool('e2e-session', 'e2e-agent', 'run_command', { command: 'pwd' })
    expect(result.success).toBe(true)
    // run_command appends an "[Exit code: N]" line; the command output is the
    // first line.
    const pwdLine = result.output?.split('\n').find((l) => l.trim() && !l.startsWith('[Exit code'))
    expect(pwdLine?.trim()).toBe(workdir)
  })

  it('executes write_file + read_file + edit_file on the remote', async () => {
    const write = await client.executeTool('e2e-session', 'e2e-agent', 'write_file', {
      path: 'e2e.txt',
      content: 'hello remote\n',
    })
    expect(write.success).toBe(true)

    const read = await client.executeTool('e2e-session', 'e2e-agent', 'read_file', { path: 'e2e.txt' })
    expect(read.success).toBe(true)
    expect(read.output).toContain('hello remote')

    const edit = await client.executeTool('e2e-session', 'e2e-agent', 'edit_file', {
      path: 'e2e.txt',
      old_string: 'hello remote',
      new_string: 'hello remote world',
    })
    expect(edit.success).toBe(true)

    const read2 = await client.executeTool('e2e-session', 'e2e-agent', 'read_file', { path: 'e2e.txt' })
    expect(read2.output).toContain('hello remote world')
    // Confirm the file actually landed on disk in the remote workdir.
    expect(readFileSync(join(workdir, 'e2e.txt'), 'utf-8')).toContain('hello remote world')
  })

  it('rejects an unknown remote with the available agents listed', async () => {
    await expect(client.executeTool('e2e-session', 'ghost', 'run_command', { command: 'echo x' })).rejects.toThrow(
      /Unknown remote agent/,
    )
  })

  it('enforces agent authentication (no Bearer / no proof / forged / replayed)', async () => {
    const base = `http://127.0.0.1:${hubPort}`
    const post = (path: string, body: Record<string, unknown>, auth?: string) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        },
        body: JSON.stringify(body),
      })

    // 1. No Bearer token -> 401 (principal auth).
    const noBearer = await post('/ra/poll', { public_key: daemon.publicKeyB64, nonce: 'x', signature: 'y' })
    expect(noBearer.status).toBe(401)

    // 2. Bearer but missing proof fields (no nonce) -> 400 (proof required).
    const noProof = await post('/ra/poll', { public_key: daemon.publicKeyB64 }, HUB_TOKEN)
    expect(noProof.status).toBe(400)

    // 3. A forged proof (wrong key) -> 401.
    const attacker = AgentIdentity.generate()
    const forgedNonce = freshNonce()
    const forged = agentProofPayload('poll', daemon.publicKeyB64, forgedNonce, daemon.hubEpoch, '')
    const badSig = await post(
      '/ra/poll',
      { public_key: daemon.publicKeyB64, nonce: forgedNonce, signature: attacker.sign(forged) },
      HUB_TOKEN,
    )
    expect(badSig.status).toBe(401)

    // 4. A valid proof but a REPLAYED nonce -> 401 (nonce is consumed).
    const nonce = freshNonce()
    const sig = daemon.signAgentProof('poll', nonce, '')
    const first = await post('/ra/poll', { public_key: daemon.publicKeyB64, nonce, signature: sig }, HUB_TOKEN)
    expect(first.status).toBe(200)
    const replayed = await post('/ra/poll', { public_key: daemon.publicKeyB64, nonce, signature: sig }, HUB_TOKEN)
    expect(replayed.status).toBe(401)

    // 5. A valid heartbeat proof works (the daemon's own key). The proof binds
    // the FULL mutable body (title, workdir, hostname, canonical capabilities).
    const hbNonce = freshNonce()
    const hbExtra = heartbeatProofExtra('e2e-agent', workdir, 'host', canonicalCapabilities([]))
    const hb = await post(
      '/ra/heartbeat',
      {
        public_key: daemon.publicKeyB64,
        title: 'e2e-agent',
        workdir: workdir,
        hostname: 'host',
        capabilities: [],
        nonce: hbNonce,
        signature: daemon.signAgentProof('heartbeat', hbNonce, hbExtra),
      },
      HUB_TOKEN,
    )
    expect(hb.status).toBe(200)

    // 6. A heartbeat proof with a TAMPERED body (different workdir) -> 401:
    // the proof no longer covers the submitted metadata.
    const hbTamperNonce = freshNonce()
    const hbTamper = await post(
      '/ra/heartbeat',
      {
        public_key: daemon.publicKeyB64,
        title: 'e2e-agent',
        workdir: '/tampered',
        hostname: 'host',
        capabilities: [],
        nonce: hbTamperNonce,
        signature: daemon.signAgentProof('heartbeat', hbTamperNonce, hbExtra),
      },
      HUB_TOKEN,
    )
    expect(hbTamper.status).toBe(401)
  })

  it('rejects a cross-agent poll (agent B cannot drain agent A queue)', async () => {
    const base = `http://127.0.0.1:${hubPort}`
    // An attacker (agent B) claiming agent A's public key but signing with
    // B's own key cannot drain agent A's queue: the hub verifies the proof
    // against the STORED key (agent A's), so the forged signature fails.
    const attacker = AgentIdentity.generate()
    const nonce = freshNonce()
    const payload = agentProofPayload('poll', daemon.publicKeyB64, nonce, daemon.hubEpoch, '')
    const res = await fetch(`${base}/ra/poll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${HUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: daemon.publicKeyB64, nonce, signature: attacker.sign(payload) }),
    })
    // The proof is over agent A's key but signed by B's key -> invalid.
    expect(res.status).toBe(401)
    // The legitimate agent is unaffected and still executes normally.
    const exec = await client.executeTool('e2e-session', 'e2e-agent', 'run_command', { command: 'echo ok' })
    expect(exec.success).toBe(true)
  })

  it('exposes public_key_b64 in the agent list (spec conformance)', async () => {
    const agents = await client.listAgents()
    const agent = agents.find((a) => a.title === 'e2e-agent')
    expect(agent).toBeDefined()
    // The raw hub response must carry the public key (the client maps it).
    // /ra/agents is a CONTROL route: it requires the control credential.
    const raw = await fetch(`http://127.0.0.1:${hubPort}/ra/agents`, {
      headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
    }).then((r) => r.json() as Promise<{ agents: Array<Record<string, unknown>> }>)
    const rawAgent = raw.agents.find((a) => a['title'] === 'e2e-agent')
    expect(rawAgent).toBeDefined()
    expect(typeof rawAgent!['public_key_b64']).toBe('string')
    expect((rawAgent!['public_key_b64'] as string).length).toBeGreaterThan(0)
  })

  it('isolates the control plane: hub Bearer is 401 on control routes, control token works', async () => {
    const base = `http://127.0.0.1:${hubPort}`
    // The shared hub Bearer must be REJECTED on the control routes (the RCE
    // surface): a peer/agent holding the hub token cannot enumerate or drive
    // remote execution.
    const agentsWithHub = await fetch(`${base}/ra/agents`, {
      headers: { Authorization: `Bearer ${HUB_TOKEN}` },
    })
    expect(agentsWithHub.status).toBe(401)

    const execWithHub = await fetch(`${base}/ra/execute`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${HUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 's', agent_peer_id: 'x', tool: 'run_command', args: {} }),
    })
    expect(execWithHub.status).toBe(401)

    const awaitWithHub = await fetch(`${base}/ra/await`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${HUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: 'nope' }),
    })
    expect(awaitWithHub.status).toBe(401)

    // The control credential IS accepted on the control routes.
    const agentsWithControl = await fetch(`${base}/ra/agents`, {
      headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
    })
    expect(agentsWithControl.status).toBe(200)

    // The control token must NOT authenticate the AGENT routes (the daemon
    // uses the hub Bearer there).
    const pollWithControl = await fetch(`${base}/ra/poll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CONTROL_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: daemon.publicKeyB64, nonce: freshNonce(), signature: 'x' }),
    })
    expect(pollWithControl.status).toBe(401)

    // And the daemon (hub Bearer + agent proof) still works end-to-end.
    const exec = await client.executeTool('e2e-session', 'e2e-agent', 'run_command', { command: 'echo ctl' })
    expect(exec.success).toBe(true)
  })

  it('round-trips Unicode through the full loop (metadata + result)', async () => {
    // Finding 17: the hub treats `extra` as raw bytes. A latin1 string
    // round-trip on the agent side would corrupt `é` (UTF-8 c3 a9) into
    // c3 83 c2 a9, so the hub's signature verification would fail. This test
    // proves Unicode survives both the heartbeat metadata (extra) and the
    // result (result_canonical) end-to-end against the real Rust hub.
    const base = `http://127.0.0.1:${hubPort}`
    const post = (path: string, body: Record<string, unknown>, auth?: string) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        },
        body: JSON.stringify(body),
      })

    // 1. A Unicode RESULT must round-trip: write a file with Unicode content
    // on the remote, read it back, and confirm the result (result_canonical,
    // signed as raw bytes) is delivered intact. (Done BEFORE the Unicode
    // heartbeat below, which renames the agent.)
    const write = await client.executeTool('e2e-session', 'e2e-agent', 'write_file', {
      path: 'unicode.txt',
      content: 'héllo wörld ünïcode\n',
    })
    expect(write.success).toBe(true)
    const read = await client.executeTool('e2e-session', 'e2e-agent', 'read_file', { path: 'unicode.txt' })
    expect(read.success).toBe(true)
    expect(read.output).toContain('héllo wörld ünïcode')
    // Confirm the file actually landed on disk with the exact Unicode bytes.
    expect(readFileSync(join(workdir, 'unicode.txt'), 'utf-8')).toContain('héllo wörld ünïcode')

    // 2. A heartbeat with Unicode METADATA (title/workdir/hostname) must be
    // accepted: the proof's extra (UTF-8 bytes) matches the hub's
    // reconstruction from the body fields.
    const unicodeTitle = 'agent-é-ünï'
    const unicodeWorkdir = '/srv/wörk-é'
    const unicodeHost = 'hôte-é'
    const caps = ['run_command', 'read_file']
    const hbExtra = heartbeatProofExtra(unicodeTitle, unicodeWorkdir, unicodeHost, canonicalCapabilities(caps))
    const hbNonce = freshNonce()
    const hbPayload = agentProofPayload('heartbeat', daemon.publicKeyB64, hbNonce, daemon.hubEpoch, hbExtra)
    const hb = await post(
      '/ra/heartbeat',
      {
        public_key: daemon.publicKeyB64,
        title: unicodeTitle,
        workdir: unicodeWorkdir,
        hostname: unicodeHost,
        capabilities: caps,
        nonce: hbNonce,
        signature: daemon.identitySign(hbPayload),
      },
      HUB_TOKEN,
    )
    // A Unicode-metadata heartbeat must be accepted (raw-byte extra).
    expect(hb.status).toBe(200)

    // Restore the agent's original metadata (the Unicode heartbeat above
    // updated the stored title/workdir) so later tests see the expected values.
    const restoreExtra = heartbeatProofExtra('e2e-agent', workdir, 'host', canonicalCapabilities([]))
    const restoreNonce = freshNonce()
    const restorePayload = agentProofPayload(
      'heartbeat',
      daemon.publicKeyB64,
      restoreNonce,
      daemon.hubEpoch,
      restoreExtra,
    )
    const restore = await post(
      '/ra/heartbeat',
      {
        public_key: daemon.publicKeyB64,
        title: 'e2e-agent',
        workdir: workdir,
        hostname: 'host',
        capabilities: [],
        nonce: restoreNonce,
        signature: daemon.identitySign(restorePayload),
      },
      HUB_TOKEN,
    )
    expect(restore.status).toBe(200)
  })

  it('drives a second agent simultaneously (multi-remote)', async () => {
    // Enroll a second agent with a different workdir.
    const workdir2 = realpathSync(mkdtempSync(join(tmpdir(), 'remote-agent-e2e-2-')))
    const daemon2 = new RemoteAgentDaemon({
      workdir: workdir2,
      hubUrl: `http://127.0.0.1:${hubPort}/mcp`,
      hubToken: HUB_TOKEN,
      name: 'e2e-agent-2',
      pollIntervalMs: 200,
      heartbeatIntervalMs: 2000,
      callTimeoutMs: 15000,
    })
    await daemon2.start()
    try {
      await new Promise<void>((resolve, reject) => {
        const started = Date.now()
        const check = async () => {
          const agents = await client.listAgents().catch(() => [])
          if (agents.some((a) => a.title === 'e2e-agent-2' && a.alive)) resolve()
          else if (Date.now() - started > 10000) reject(new Error('agent 2 did not enroll'))
          else setTimeout(check, 200)
        }
        check()
      })

      // Same session drives both agents.
      const r1 = await client.executeTool('e2e-session', 'e2e-agent', 'run_command', { command: 'pwd' })
      const r2 = await client.executeTool('e2e-session', 'e2e-agent-2', 'run_command', { command: 'pwd' })
      const firstLine = (out?: string) => out?.split('\n').find((l) => l.trim() && !l.startsWith('[Exit code'))
      expect(firstLine(r1.output)?.trim()).toBe(workdir)
      expect(firstLine(r2.output)?.trim()).toBe(workdir2)
    } finally {
      await daemon2.stop()
      rmSync(workdir2, { recursive: true, force: true })
    }
  })
})
