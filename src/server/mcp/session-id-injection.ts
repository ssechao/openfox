export type SessionIdInjectionResult = { ok: true; args: Record<string, unknown> } | { ok: false; error: string }

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
