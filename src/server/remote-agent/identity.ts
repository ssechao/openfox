import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'

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
 * Canonical serialization of the envelope payload (everything except the
 * signature). Must match the hub's `canonical_payload` byte-for-byte:
 * fields joined with 0x1f, args as their JSON string.
 */
export function canonicalEnvelopePayload(
  requestId: string,
  agentPeerId: string,
  sessionId: string,
  tool: string,
  argsJson: string,
): Buffer {
  const parts = [requestId, agentPeerId, sessionId, tool, argsJson]
  const sep = Buffer.from([0x1f])
  return Buffer.concat(parts.map((p, i) => (i === 0 ? Buffer.from(p) : Buffer.concat([sep, Buffer.from(p)]))))
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
 * metadata (title, key, workdir, hostname, capabilities) + a fresh nonce, so
 * a captured enrollment cannot be replayed with modified metadata.
 * Must match the hub's `enroll_payload` byte-for-byte.
 */
export function enrollPayload(
  title: string,
  publicKeyB64: string,
  workdir: string,
  hostname: string,
  capabilitiesCanonical: string,
  nonce: string,
): Buffer {
  const parts = ['ra-enroll', title, publicKeyB64, workdir, hostname, capabilitiesCanonical, nonce]
  return Buffer.concat(
    parts.map((p, i) => (i === 0 ? Buffer.from(p) : Buffer.concat([Buffer.from([0x1f]), Buffer.from(p)]))),
  )
}

/**
 * Canonical agent-proof payload (poll / heartbeat / result). The agent signs
 * this with its private key; the hub verifies it against the STORED public
 * key and consumes the nonce (single-use). `extra` binds the request_id for
 * /ra/result. Must match the hub's `agent_proof_payload` byte-for-byte.
 */
export function agentProofPayload(op: string, publicKeyB64: string, nonce: string, extra: string): Buffer {
  const parts = [op, publicKeyB64, nonce, extra]
  return Buffer.concat(
    parts.map((p, i) => (i === 0 ? Buffer.from(p) : Buffer.concat([Buffer.from([0x1f]), Buffer.from(p)]))),
  )
}
