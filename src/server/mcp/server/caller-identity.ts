import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { McpServerConfig, OpenFoxCallerIdentityIssueInput, OpenFoxEndpointBindingInput } from '../types.js'

export const OPENFOX_CALLER_IDENTITY_TTL_MS = 30_000

export interface OpenFoxCallerIdentityVerification extends OpenFoxCallerIdentityIssueInput {
  proof: unknown
}

export type OpenFoxCallerIdentityResult = { ok: true; callerSessionId: string } | { ok: false; error: string }

export interface OpenFoxCallerIdentityAuthority {
  issueProof(input: OpenFoxCallerIdentityIssueInput): string
  verify(input: OpenFoxCallerIdentityVerification): OpenFoxCallerIdentityResult
}

interface AuthorityOptions {
  secret?: Buffer
  now?: () => number
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export interface OpenFoxEndpointBindingOptions {
  selfEndpointUrl(): string
  proxyServerName: string
  proxyTargetName: string
  getProxyConfig(serverName: string): McpServerConfig | undefined
  resolveProxyTargetUrl(serverName: string, targetServerName: string): string | undefined
}

export function createOpenFoxEndpointBinding(
  options: OpenFoxEndpointBindingOptions,
): (input: OpenFoxEndpointBindingInput) => boolean {
  return (input) => {
    if (input.kind === 'direct') {
      return input.url === options.selfEndpointUrl()
    }
    const proxyConfig = options.getProxyConfig(input.serverName)
    const commandParts = [proxyConfig?.command, ...(proxyConfig?.args ?? [])].filter(
      (part): part is string => typeof part === 'string',
    )
    return (
      input.serverName === options.proxyServerName &&
      input.targetServerName === options.proxyTargetName &&
      proxyConfig?.transport === 'stdio' &&
      commandParts.some((part) => part === 'mcp-lazy' || part.endsWith('/mcp-lazy'))
    )
  }
}

export function createOpenFoxCallerIdentityAuthority(options: AuthorityOptions = {}): OpenFoxCallerIdentityAuthority {
  const secret = options.secret ? Buffer.from(options.secret) : randomBytes(32)
  const now = options.now ?? Date.now

  const invalid = (): OpenFoxCallerIdentityResult => ({
    ok: false,
    error: 'trusted OpenFox caller identity is required',
  })

  return {
    issueProof(input) {
      if (!validText(input.callerSessionId) || !validText(input.toolName) || !validText(input.targetSessionId)) {
        throw new Error('caller identity tuple is incomplete')
      }
      const expiresAt = now() + OPENFOX_CALLER_IDENTITY_TTL_MS
      const payload = Buffer.from(
        JSON.stringify([1, input.callerSessionId, input.toolName, input.targetSessionId, expiresAt]),
      ).toString('base64url')
      const mac = createHmac('sha256', secret).update(payload).digest('base64url')
      return `${payload}.${mac}`
    },

    verify(input) {
      if (
        !validText(input.callerSessionId) ||
        !validText(input.toolName) ||
        !validText(input.targetSessionId) ||
        !validText(input.proof)
      ) {
        return invalid()
      }
      const parts = input.proof.split('.')
      if (parts.length !== 2 || !parts[0] || !parts[1]) return invalid()
      const expectedMac = createHmac('sha256', secret).update(parts[0]).digest()
      let actualMac: Buffer
      try {
        actualMac = Buffer.from(parts[1], 'base64url')
      } catch {
        return invalid()
      }
      if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) {
        return invalid()
      }

      let decoded: unknown
      try {
        decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
      } catch {
        return invalid()
      }
      if (!Array.isArray(decoded) || decoded.length !== 5) return invalid()
      const [version, callerSessionId, toolName, targetSessionId, expiresAt] = decoded
      if (
        version !== 1 ||
        callerSessionId !== input.callerSessionId ||
        toolName !== input.toolName ||
        targetSessionId !== input.targetSessionId ||
        typeof expiresAt !== 'number' ||
        !Number.isSafeInteger(expiresAt)
      ) {
        return invalid()
      }
      const currentTime = now()
      if (
        (expiresAt as number) <= currentTime ||
        (expiresAt as number) > currentTime + OPENFOX_CALLER_IDENTITY_TTL_MS
      ) {
        return {
          ok: false,
          error: 'trusted OpenFox caller identity expired',
        }
      }
      return { ok: true, callerSessionId: input.callerSessionId }
    },
  }
}
