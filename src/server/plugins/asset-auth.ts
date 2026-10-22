const PLUGIN_ASSET_PATH = /^\/plugins\/[^/]+\/assets\//
const BLOB_ASSET_PATH = /^\/(?:api\/)?blobs\/[a-f0-9]{64}$/

/**
 * Plugin assets and session blobs are loaded by <img>/iframe, which cannot
 * attach the `x-session-token` header. They may instead present the session
 * token as a `token` query parameter, and only on those asset URLs.
 */
export function pluginAssetToken(req: { path: string; query: Record<string, unknown> }): string | undefined {
  if (!PLUGIN_ASSET_PATH.test(req.path) && !BLOB_ASSET_PATH.test(req.path)) return undefined
  const token = req.query['token']
  return typeof token === 'string' && token.length > 0 ? token : undefined
}
