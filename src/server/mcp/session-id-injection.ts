import type { McpServerConfig, OpenFoxCallerIdentityGateway, OpenFoxEndpointBindingInput } from './types.js'

export type SessionIdInjectionResult = { ok: true; args: Record<string, unknown> } | { ok: false; error: string }

const OPENFOX_DELETE_SESSION_TOOL = 'openfox_delete_session'

function isArgumentsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ownEndpointBinding(identity: OpenFoxCallerIdentityGateway, input: OpenFoxEndpointBindingInput): boolean {
  try {
    return identity.isOwnEndpoint(input)
  } catch {
    return false
  }
}

export function applyOpenFoxCallerIdentityInjection(
  identity: OpenFoxCallerIdentityGateway | undefined,
  serverName: string,
  config: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  sessionId: string | undefined,
): SessionIdInjectionResult {
  let targetSessionId: unknown
  let sanitizedArgs: Record<string, unknown> | undefined
  let inject: ((callerSessionId: string, proof: string) => Record<string, unknown>) | undefined
  let binding: OpenFoxEndpointBindingInput | undefined

  if (toolName === OPENFOX_DELETE_SESSION_TOOL) {
    const { openfox_session_id: _modelSessionId, openfox_session_proof: _modelProof, ...sanitized } = args
    targetSessionId = sanitized['sessionId']
    sanitizedArgs = sanitized
    binding = {
      kind: 'direct',
      serverName,
      ...(config.url ? { url: config.url } : {}),
    }
    inject = (callerSessionId, proof) => ({
      ...sanitized,
      openfox_session_id: callerSessionId,
      openfox_session_proof: proof,
    })
  } else if (
    toolName === 'mcp_execute_tool' &&
    typeof args['server_name'] === 'string' &&
    args['tool_name'] === OPENFOX_DELETE_SESSION_TOOL
  ) {
    const inner = args['arguments']
    if (!isArgumentsObject(inner)) {
      return { ok: false, error: 'trusted OpenFox caller identity requires object arguments' }
    }
    const { openfox_session_id: _modelSessionId, openfox_session_proof: _modelProof, ...sanitizedInner } = inner
    targetSessionId = sanitizedInner['sessionId']
    sanitizedArgs = { ...args, arguments: sanitizedInner }
    binding = {
      kind: 'proxy',
      serverName,
      ...(config.url ? { url: config.url } : {}),
      targetServerName: args['server_name'],
    }
    inject = (callerSessionId, proof) => ({
      ...args,
      arguments: {
        ...sanitizedInner,
        openfox_session_id: callerSessionId,
        openfox_session_proof: proof,
      },
    })
  }

  if (!binding || !inject || !sanitizedArgs) return { ok: true, args }
  if (!identity || !ownEndpointBinding(identity, binding)) {
    return { ok: true, args: sanitizedArgs }
  }
  if (!sessionId) {
    return { ok: false, error: 'trusted OpenFox caller session is required' }
  }
  if (typeof targetSessionId !== 'string' || targetSessionId.length === 0) {
    return { ok: false, error: 'target sessionId is required for trusted OpenFox caller identity' }
  }

  let proof: string
  try {
    proof = identity.issueProof({
      callerSessionId: sessionId,
      toolName: OPENFOX_DELETE_SESSION_TOOL,
      targetSessionId,
    })
  } catch {
    return { ok: false, error: 'trusted OpenFox caller identity could not be issued' }
  }
  return { ok: true, args: inject(sessionId, proof) }
}

export function applySessionIdInjection(
  injection: Record<string, string> | undefined,
  args: Record<string, unknown>,
  sessionId: string | undefined,
): SessionIdInjectionResult {
  const target = args['server_name']
  if (!injection || typeof target !== 'string') return { ok: true, args }
  const paramName: unknown = injection[target]
  if (typeof paramName !== 'string' || paramName.length === 0) return { ok: true, args }
  if (!sessionId) {
    return { ok: false, error: `a session id is required to call '${target}' through this proxy` }
  }
  const inner = args['arguments']
  if (inner !== undefined && (typeof inner !== 'object' || inner === null || Array.isArray(inner))) {
    return { ok: false, error: `arguments for '${target}' must be an object to carry '${paramName}'` }
  }
  return {
    ok: true,
    args: { ...args, arguments: { ...(inner as Record<string, unknown> | undefined), [paramName]: sessionId } },
  }
}
