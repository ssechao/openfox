/**
 * Frozen from origin/mt/etape3-async (pre-4a-1):
 * - src/server/context/image-processor.ts hasImageMetadata
 * - src/server/events/fold-messages.ts handleToolResult image branch
 */
export function hasImageMetadata(result: { metadata?: Record<string, unknown> }): boolean {
  const meta = result.metadata
  if (!meta) return false
  const dataUrl = meta['dataUrl']
  const mimeType = meta['mimeType']
  return typeof dataUrl === 'string' && typeof mimeType === 'string' && mimeType.startsWith('image/')
}

export function attachmentDataFromToolMetadata(metadata: {
  mimeType?: string
  dataUrl?: string
  path?: string
  size?: number
}): string | undefined {
  if (metadata?.dataUrl && metadata?.mimeType?.startsWith('image/')) {
    return metadata.dataUrl
  }
  return undefined
}
