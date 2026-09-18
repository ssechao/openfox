import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'

/**
 * Ed25519 identity for a headless-agent. The private key never leaves the
 * machine; the public key is registered with the hub and used to verify the
 * hub's signatures on execution envelopes.
 */
export class AgentIdentity {
  private constructor(
    private readonly privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
    private readonly publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'],
  ) {}

  static generate(): AgentIdentity {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    return new AgentIdentity(privateKey, publicKey)
  }

  /** Base64url-encoded raw 32-byte public key (matches the hub's encoding). */
  get publicKeyB64(): string {
    const der = this.publicKey.export({ type: 'spki', format: 'der' })
    // SPKI DER prefix for Ed25519 is 12 bytes; the raw key is the last 32.
    return Buffer.from(der.subarray(der.length - 32)).toString('base64url')
  }

  /** Sign a message (e.g. the hub enrollment nonce). Base64url signature. */
  sign(message: string | Buffer): string {
    const sig = sign(null, Buffer.from(message), this.privateKey)
    return sig.toString('base64url')
  }
}

/**
 * Verify a base64url Ed25519 signature over a message, given a base64url
 * 32-byte raw public key (as stored by the hub).
 */
export function verifyHubSignature(hubPublicKeyB64: string, message: string | Buffer, signatureB64: string): boolean {
  try {
    const raw = Buffer.from(hubPublicKeyB64, 'base64url')
    if (raw.length !== 32) return false
    // Rebuild an SPKI public key from the raw 32 bytes (Ed25519 prefix).
    const prefix = Buffer.from('302a300506032b6570032100', 'hex')
    const spki = Buffer.concat([prefix, raw])
    const pem = `-----BEGIN PUBLIC KEY-----\n${spki
      .toString('base64')
      .match(/.{1,64}/g)!
      .join('\n')}\n-----END PUBLIC KEY-----`
    const publicKey = createPublicKey(pem)
    return verify(null, Buffer.from(message), publicKey, Buffer.from(signatureB64, 'base64url'))
  } catch {
    return false
  }
}

/**
 * Append a length-prefixed (u32 big-endian) field to an array of buffers.
 * This makes the canonical encoding **injective**: field boundaries are
 * unambiguous, so a delimiter byte (0x1f) inside a field can never be
 * confused with a field separator — `["a","b\x1fc"] != ["a\x1fb","c"]`.
 * Must match the hub's `push_field` byte-for-byte.
 */
function pushField(out: Buffer[], field: Buffer): void {
  const len = Buffer.allocUnsafe(4)
  len.writeUInt32BE(field.length, 0)
  out.push(len, field)
}

/**
 * Canonical serialization of the envelope payload (everything except the
 * signature). Must match the hub's `canonical_payload` byte-for-byte: each
 * field is length-prefixed (u32 BE) then its UTF-8 bytes (injective).
 */
export function canonicalEnvelopePayload(
  requestId: string,
  agentPeerId: string,
  sessionId: string,
  tool: string,
  argsJson: string,
): Buffer {
  const out: Buffer[] = []
  for (const p of [requestId, agentPeerId, sessionId, tool, argsJson]) pushField(out, Buffer.from(p))
  return Buffer.concat(out)
}

/**
 * Canonical capabilities string (sorted, compact JSON array of strings).
 * Must match the hub's `canonical_capabilities` so the enrollment signature
 * binds the capabilities deterministically on both sides.
 */
export function canonicalCapabilities(capabilities: string[]): string {
  const sorted = [...capabilities].sort()
  return `[${sorted.map((c) => JSON.stringify(c)).join(',')}]`
}

/**
 * Canonical enrollment payload. The agent signs this with its private key;
 * the hub verifies it against the supplied public key. Binds ALL enrollment
 * metadata (title, key, workdir, hostname, capabilities) + a fresh nonce +
 * the hub's **startup epoch** (fetched via `GET /ra/epoch` before enrolling),
 * so a captured enrollment cannot be replayed with modified metadata AND is
 * invalid after a hub restart (the restarted hub reconstructs the payload
 * with its OWN epoch, so the old signature no longer matches — even with an
 * empty nonce cache and a nonce still inside the replay window).
 * Must match the hub's `enroll_payload` byte-for-byte.
 */
export function enrollPayload(
  title: string,
  publicKeyB64: string,
  workdir: string,
  hostname: string,
  capabilitiesCanonical: string,
  nonce: string,
  epoch: string,
): Buffer {
  const out: Buffer[] = []
  for (const p of ['ra-enroll', title, publicKeyB64, workdir, hostname, capabilitiesCanonical, nonce, epoch])
    pushField(out, Buffer.from(p))
  return Buffer.concat(out)
}

/**
 * Injective canonical body: each part is length-prefixed (u32 BE) then its
 * UTF-8 bytes. Field boundaries are unambiguous (no delimiter collision).
 * Must match the hub's `canonical_body` byte-for-byte.
 */
export function canonicalBody(parts: string[]): Buffer {
  const out: Buffer[] = []
  for (const p of parts) pushField(out, Buffer.from(p))
  return Buffer.concat(out)
}

/**
 * The `extra` of a **heartbeat** proof: binds the full mutable heartbeat body
 * (title, workdir, hostname, canonical capabilities) so a captured heartbeat
 * cannot be replayed with modified metadata. Must match the hub's
 * `heartbeat_proof_extra` byte-for-byte.
 */
export function heartbeatProofExtra(
  title: string,
  workdir: string,
  hostname: string,
  capabilitiesCanonical: string,
): Buffer {
  return canonicalBody([title, workdir, hostname, capabilitiesCanonical])
}

/**
 * The `extra` of a **result** proof: binds the request id, the scoped token,
 * and the canonical result JSON so none of them can be tampered with. The hub
 * stores/delivers `resultCanonical` (the signed string). Must match the hub's
 * `result_proof_extra` byte-for-byte.
 */
export function resultProofExtra(requestId: string, token: string, resultCanonical: string): Buffer {
  return canonicalBody([requestId, token, resultCanonical])
}

/**
 * A fresh timestamped nonce: `<unix_ms>-<random>`. The timestamp gives the
 * hub a replay window (a captured nonce is only acceptable while its
 * timestamp is within the window, so replay resistance survives a cache
 * prune or hub restart). The random part uses `crypto.randomBytes` (NOT
 * `Math.random`) so it is unguessable. Must match the hub's `parse_nonce_ts`.
 */
export function freshNonce(): string {
  return `${Date.now()}-${randomBytes(16).toString('hex')}`
}

/**
 * Canonical agent-proof payload (poll / heartbeat / result). The agent signs
 * this with its private key; the hub verifies it against the STORED public
 * key and consumes the nonce (single-use). `epoch` binds the hub's startup
 * epoch (a captured proof from a previous hub process is invalid after a
 * restart, so single-use is robust to a lost nonce cache). `extra` binds the
 * operation's FULL mutable body (see `heartbeatProofExtra` /
 * `resultProofExtra`).
 *
 * **Unicode-safe**: `extra` is used as RAW BYTES (no string round-trip), so
 * non-ASCII bytes (e.g. `é` = `c3 a9`) are preserved exactly — matching the
 * hub, which treats `extra` as `&[u8]`. All fields are length-prefixed
 * (injective). Must match the hub's `agent_proof_payload` byte-for-byte.
 */
export function agentProofPayload(
  op: string,
  publicKeyB64: string,
  nonce: string,
  epoch: string,
  extra: string | Buffer,
): Buffer {
  const out: Buffer[] = []
  pushField(out, Buffer.from(op))
  pushField(out, Buffer.from(publicKeyB64))
  pushField(out, Buffer.from(nonce))
  pushField(out, Buffer.from(epoch))
  pushField(out, Buffer.isBuffer(extra) ? extra : Buffer.from(extra))
  return Buffer.concat(out)
}
