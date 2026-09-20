import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { AgentIdentity } from './identity.js'

/**
 * Durable Ed25519 identity for a headless-agent.
 *
 * WHY PERSIST: the daemon used to call `AgentIdentity.generate()` at every
 * start, so each restart produced a NEW key → a NEW peer id (the hub derives
 * it from the public key). The documented "stable peer id" contract only held
 * for the lifetime of one process, and every restart left the previous entry
 * to expire on its own.
 *
 * SECURITY — the key file is a durable REMOTE-EXECUTION CREDENTIAL: whoever
 * holds it can answer `/ra/poll` and execute commands as this agent. The hub
 * epoch and the nonces do NOT protect against that (a thief signs fresh
 * nonces). It must therefore be stored 0600, owned by the current user, and
 * never committed. We FAIL CLOSED: a key readable by group/others, or owned by
 * another user, is refused rather than used silently.
 *
 * The path is scoped PER AGENT (`<name>.key`), never per user: two daemons on
 * the same host with different names must not share a key, or they would
 * collide on the same peer id.
 */

export const IDENTITY_DIR_MODE = 0o700
export const IDENTITY_FILE_MODE = 0o600

export interface LoadIdentityOptions {
  /** Agent name (the daemon's --name). Scopes the default key path per agent. */
  name: string
  /** Explicit key path (`--identity-key` / `OPENFOX_RA_IDENTITY_KEY`). Wins. */
  explicitPath?: string | undefined
  /** Generate a NEW key, replacing any existing one (`--rotate-identity`). */
  rotate?: boolean | undefined
  /** Home directory override (tests). */
  home?: string | undefined
}

export interface LoadedIdentity {
  identity: AgentIdentity
  path: string
  /** The key did not exist and was generated + persisted. */
  created: boolean
  /** An existing key was deliberately replaced (`--rotate-identity`). */
  rotated: boolean
}

/** Filesystem-safe file name for an agent name. */
export function sanitizeAgentName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
  return cleaned.length > 0 ? cleaned : 'default'
}

/** Per-agent default key path: `<home>/.config/openfox/remote-agent/<name>.key`. */
export function defaultIdentityPath(name: string, home: string = homedir()): string {
  return join(home, '.config', 'openfox', 'remote-agent', `${sanitizeAgentName(name)}.key`)
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

/**
 * Fail closed if `path` is readable by group/others or owned by another user.
 * A 0600 file owned by someone else is as suspicious as a 0644 one — the mode
 * alone does not detect it.
 */
function assertPrivateKeyFile(path: string): void {
  const st = statSync(path)
  const mode = st.mode & 0o777
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `refusing to load the remote-agent identity key ${path}: it is readable by group/others ` +
        `(mode ${mode.toString(8)}). Fix it with: chmod 600 ${path}`,
    )
  }
  const uid = currentUid()
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(
      `refusing to load the remote-agent identity key ${path}: it is owned by uid ${st.uid}, not by the current user (uid ${uid}).`,
    )
  }
}

/** Fail closed if the identity directory is accessible to group/others. */
function assertPrivateDir(dir: string): void {
  const st = statSync(dir)
  const mode = st.mode & 0o777
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `refusing to use the remote-agent identity directory ${dir}: it is accessible to group/others ` +
        `(mode ${mode.toString(8)}). Fix it with: chmod 700 ${dir}`,
    )
  }
  const uid = currentUid()
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(
      `refusing to use the remote-agent identity directory ${dir}: it is owned by uid ${st.uid}, not by the current user (uid ${uid}).`,
    )
  }
}

/**
 * Resolve the agent identity, in this order:
 *   1. an explicit key path (`--identity-key` / env) — loaded if present,
 *      created there otherwise;
 *   2. a persisted per-agent key at the default path;
 *   3. otherwise generate a fresh key and persist it.
 *
 * Fails closed on unsafe permissions/ownership. With `rotate`, any existing
 * key is replaced by a new one (documented revocation path).
 */
export function loadOrCreateIdentity(opts: LoadIdentityOptions): LoadedIdentity {
  const explicit = opts.explicitPath?.trim()
  const isDefaultPath = explicit === undefined || explicit.length === 0
  const path = isDefaultPath ? defaultIdentityPath(opts.name, opts.home) : explicit
  const dir = dirname(path)

  // Ensure the directory exists (0700). For OUR default directory we also
  // enforce its permissions: a loose/foreign directory is refused rather than
  // silently tightened — a problem nobody notices is worse than a loud one.
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: IDENTITY_DIR_MODE })
  } else if (isDefaultPath) {
    assertPrivateDir(dir)
  }

  let rotated = false
  if (opts.rotate && existsSync(path)) {
    unlinkSync(path)
    rotated = true
  }

  if (existsSync(path)) {
    assertPrivateKeyFile(path)
    const identity = AgentIdentity.fromPrivateKeyDer(readFileSync(path))
    return { identity, path, created: false, rotated }
  }

  const identity = AgentIdentity.generate()
  writeFileSync(path, identity.privateKeyDer, { mode: IDENTITY_FILE_MODE })
  // Umask can widen the mode at creation; enforce it explicitly.
  chmodSync(path, IDENTITY_FILE_MODE)
  return { identity, path, created: true, rotated }
}
