import type { StoredEvent, TurnEvent, SessionSnapshot, SnapshotMessage } from '../events/types.js'
import type { Attachment, ToolResult } from '../../shared/types.js'
import { describeImageFromDataUrl } from '../llm/vision-fallback.js'
import type { VisionBackend } from '../llm/vision-fallback.js'
import { getRuntimeConfig } from '../runtime-config.js'
import { extractPdfContent } from '../tools/pdf-utils.js'
import type { PdfBlock } from '../tools/pdf-utils.js'
import { contentHash, cacheSet } from '../utils/cache.js'
import { decodeDataUrl } from '../utils/data-url.js'
import { hydrateAttachmentData } from '../events/blob-codec.js'

export interface ResolvedVisionModel {
  baseUrl: string
  model: string
  timeout: number
  backend: VisionBackend
  apiKey?: string
}

export async function loadVisionModelFromGlobalConfig(): Promise<ResolvedVisionModel | undefined> {
  try {
    const { loadGlobalConfig, resolveVisionFallback } = await import('../../cli/config.js')
    const runtimeConfig = getRuntimeConfig()
    const mode = runtimeConfig.mode ?? 'production'
    const globalConfig = await loadGlobalConfig(mode)
    return resolveVisionFallback(globalConfig)
  } catch {
    // Global config not available
  }
  return undefined
}

/**
 * Resolve the vision fallback model to use, preferring the in-memory runtime
 * config (dev/CLI) and falling back to the persisted global config. Returns
 * undefined when no vision fallback is configured.
 */
export async function loadResolvedVisionModel(): Promise<ResolvedVisionModel | undefined> {
  const runtimeConfig = getRuntimeConfig()
  const llm = runtimeConfig.llm
  if (llm?.visionModel) {
    return {
      baseUrl: llm.baseUrl,
      model: llm.visionModel,
      timeout: llm.timeout,
      backend: (llm.backend === 'ollama' ? 'ollama' : 'openai') as VisionBackend,
    }
  }
  return loadVisionModelFromGlobalConfig()
}

export interface ImageProcessorOptions {
  modelSupportsVision: boolean
  visionModel?: ResolvedVisionModel
  signal?: AbortSignal
  onEvent?: (event: TurnEvent) => void
  /** Called to persist enriched event data (e.g., attachment descriptions) back to the event store */
  persistEvent?: (sessionId: string, seq: number, data: unknown) => void
}

export interface ProcessContextResult {
  events: StoredEvent[]
  descriptions: Map<string, string>
}

const descriptionCache = new Map<string, string>()

export function clearImageDescriptionCache(): void {
  descriptionCache.clear()
}

function isImageAttachment(att: Attachment): boolean {
  return att.mimeType.startsWith('image/')
}

function isPdfAttachment(att: Attachment): boolean {
  return att.mimeType === 'application/pdf'
}

function hasImageMetadata(result: { metadata?: Record<string, unknown> }): boolean {
  const meta = result.metadata
  if (!meta) return false
  const dataUrl = meta['dataUrl']
  const mimeType = meta['mimeType']
  return typeof dataUrl === 'string' && typeof mimeType === 'string' && (mimeType as string).startsWith('image/')
}

function mapChanged<T>(values: T[], transform: (value: T) => T): T[] {
  let result = values
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!
    const next = transform(value)
    if (next === value) continue
    if (result === values) result = values.slice()
    result[index] = next
  }
  return result
}

function copyPendingAttachments(attachments: Attachment[]): Attachment[] {
  return mapChanged(attachments, (att) =>
    (isImageAttachment(att) && !att.description) || (isPdfAttachment(att) && !att.pdfContent) ? { ...att } : att,
  )
}

function copyPendingImageResult(result: ToolResult): ToolResult {
  if (!result.metadata || !hasImageMetadata(result) || result.metadata['description']) return result
  return { ...result, metadata: { ...result.metadata } }
}

function copyPendingSnapshotMessage(message: SnapshotMessage): SnapshotMessage {
  if (message.role === 'user' && message.attachments) {
    const attachments = copyPendingAttachments(message.attachments)
    return attachments === message.attachments ? message : { ...message, attachments }
  }
  if (message.role === 'assistant' && message.toolCalls) {
    const toolCalls = mapChanged(message.toolCalls, (toolCall) => {
      if (!toolCall.result) return toolCall
      const result = copyPendingImageResult(toolCall.result)
      return result === toolCall.result ? toolCall : { ...toolCall, result }
    })
    return toolCalls === message.toolCalls ? message : { ...message, toolCalls }
  }
  return message
}

function copyPendingEnrichment(event: StoredEvent): StoredEvent {
  if (event.type === 'message.start') {
    const data = event.data as Extract<TurnEvent, { type: 'message.start' }>['data']
    if (!data.attachments) return event
    const attachments = copyPendingAttachments(data.attachments)
    return attachments === data.attachments ? event : { ...event, data: { ...data, attachments } }
  }
  if (event.type === 'tool.result') {
    const data = event.data as Extract<TurnEvent, { type: 'tool.result' }>['data']
    const result = copyPendingImageResult(data.result)
    return result === data.result ? event : { ...event, data: { ...data, result } }
  }
  if (event.type === 'turn.snapshot') {
    const data = event.data as SessionSnapshot
    const messages = mapChanged(data.messages, copyPendingSnapshotMessage)
    return messages === data.messages ? event : { ...event, data: { ...data, messages } }
  }
  return event
}

async function describeImageDataUrl(
  dataUrl: string,
  attachmentId: string,
  messageId: string,
  options: ImageProcessorOptions,
  descriptions: Map<string, string>,
  filename?: string,
): Promise<string> {
  const cacheKey = contentHash(dataUrl)
  if (descriptionCache.has(cacheKey)) {
    const cached = descriptionCache.get(cacheKey)!
    descriptions.set(attachmentId, cached)
    return cached
  }

  if (options.visionModel) {
    const startData: { messageId: string; attachmentId: string; filename?: string } = {
      messageId,
      attachmentId,
    }
    if (filename !== undefined) {
      startData.filename = filename
    }
    options.onEvent?.({ type: 'vision_fallback.start', data: startData })

    const description = await describeImageFromDataUrl(dataUrl, options.visionModel, {
      context: filename ? `File: ${filename}` : undefined,
      signal: options.signal,
    })

    cacheSet(descriptionCache, cacheKey, description)
    descriptions.set(attachmentId, description)

    options.onEvent?.({ type: 'vision_fallback.done', data: { messageId, attachmentId, description } })

    return description
  }

  const placeholder = filename ? `[Image: ${filename}]` : '[Image]'
  descriptions.set(attachmentId, placeholder)
  return placeholder
}

async function describeAttachment(
  att: Attachment,
  messageId: string,
  options: ImageProcessorOptions,
  descriptions: Map<string, string>,
): Promise<string> {
  return describeImageDataUrl(hydrateAttachmentData(att), att.id, messageId, options, descriptions, att.filename)
}

async function describePdfAttachment(
  att: Attachment,
  messageId: string,
  options: ImageProcessorOptions,
  descriptions: Map<string, string>,
): Promise<string> {
  const hasVision = !!options.visionModel
  const cacheKey = `pdf:${hasVision}:${contentHash(hydrateAttachmentData(att))}`
  const filenameLabel = att.filename || 'document.pdf'
  if (descriptionCache.has(cacheKey)) {
    const cached = descriptionCache.get(cacheKey)!
    const output = `[PDF: ${filenameLabel}]${cached}`
    descriptions.set(att.id, output)
    return output
  }

  const buffer = decodeDataUrl(hydrateAttachmentData(att))
  if (!buffer) {
    const fallback = `[PDF: ${filenameLabel}] (could not decode)`
    cacheSet(descriptionCache, cacheKey, fallback)
    descriptions.set(att.id, fallback)
    return fallback
  }

  let blocks: PdfBlock[]
  try {
    const result = await extractPdfContent(buffer)
    blocks = result.blocks
  } catch {
    const errorText = `[PDF: ${filenameLabel}] (could not extract content)`
    descriptions.set(att.id, errorText)
    return errorText
  }

  let body = ''

  let imageIndex = 0
  for (const block of blocks) {
    if (block.type === 'text' && block.content) {
      body += '\n\n' + block.content
    } else if (block.type === 'image' && block.dataUrl) {
      const imgAttachmentId = `${att.id}/image-${imageIndex}`
      const description = await describeImageDataUrl(block.dataUrl, imgAttachmentId, messageId, options, descriptions)
      body += '\n\n' + description
      imageIndex++
    }
  }

  const output = `[PDF: ${filenameLabel}]${body}`
  cacheSet(descriptionCache, cacheKey, body)
  descriptions.set(att.id, output)
  return output
}

/**
 * Enrich image attachments with vision fallback descriptions.
 *
 * Unlike the old approach (which replaced content and deleted attachments on clones),
 * this enriches attachments with a `description` field and persists the enriched data
 * back to the event store. The original image data and attachments array are kept intact
 * so the UI continues to display images.
 *
 * For non-vision models, the LLM context builder uses `attachment.description` instead
 * of the raw image data. For vision models, the description is ignored.
 */
export async function processContextImages(
  events: StoredEvent[],
  options: ImageProcessorOptions,
): Promise<ProcessContextResult> {
  if (options.modelSupportsVision) {
    return { events, descriptions: new Map() }
  }

  const descriptions = new Map<string, string>()
  const modifiedEvents = mapChanged(events, copyPendingEnrichment)

  for (const event of modifiedEvents) {
    if (event.type === 'message.start') {
      const data = event.data as Extract<TurnEvent, { type: 'message.start' }>['data']
      if (!data.attachments || data.attachments.length === 0) continue

      let enriched = false

      const imageAtts = data.attachments.filter(isImageAttachment)
      for (const att of imageAtts) {
        if (att.description) {
          descriptions.set(att.id, att.description)
          continue
        }
        const description = await describeAttachment(att, data.messageId, options, descriptions)
        att.description = description
        enriched = true
      }

      const pdfAtts = data.attachments.filter(isPdfAttachment)
      for (const att of pdfAtts) {
        if (att.pdfContent) {
          descriptions.set(att.id, att.pdfContent)
          continue
        }
        const pdfContent = await describePdfAttachment(att, data.messageId, options, descriptions)
        att.pdfContent = pdfContent
        enriched = true
      }

      if (enriched && options.persistEvent) {
        options.persistEvent(event.sessionId, event.seq, data)
      }
    }

    if (event.type === 'tool.result') {
      const data = event.data as Extract<TurnEvent, { type: 'tool.result' }>['data']
      if (!data.result.metadata || !hasImageMetadata(data.result)) continue

      const meta = data.result.metadata
      // Skip if already has a description
      if (meta['description']) {
        descriptions.set(data.toolCallId, meta['description'] as string)
        continue
      }

      const dataUrl = meta['dataUrl'] as string
      const path = meta['path'] as string | undefined

      const description = await describeImageDataUrl(
        dataUrl,
        data.toolCallId,
        data.messageId,
        options,
        descriptions,
        path,
      )

      meta['description'] = description

      // Persist enriched metadata back to the store
      if (options.persistEvent) {
        options.persistEvent(event.sessionId, event.seq, data)
      }
    }

    if (event.type === 'turn.snapshot') {
      const snapshot = event.data as SessionSnapshot
      let enriched = false

      for (const message of snapshot.messages) {
        if (message.role === 'user' && message.attachments && message.attachments.length > 0) {
          for (const att of message.attachments) {
            if (isImageAttachment(att)) {
              if (att.description) {
                descriptions.set(att.id, att.description)
                continue
              }
              const description = await describeAttachment(att, message.id, options, descriptions)
              att.description = description
              enriched = true
            } else if (isPdfAttachment(att)) {
              if (att.pdfContent) {
                descriptions.set(att.id, att.pdfContent)
                continue
              }
              const pdfContent = await describePdfAttachment(att, message.id, options, descriptions)
              att.pdfContent = pdfContent
              enriched = true
            }
          }
        }

        if (message.role === 'assistant' && message.toolCalls) {
          for (const toolCall of message.toolCalls) {
            if (!toolCall.result || !toolCall.result.metadata || !hasImageMetadata(toolCall.result)) continue

            const meta = toolCall.result.metadata
            if (meta['description']) {
              descriptions.set(toolCall.id, meta['description'] as string)
              continue
            }

            const dataUrl = meta['dataUrl'] as string
            const path = meta['path'] as string | undefined

            const description = await describeImageDataUrl(
              dataUrl,
              toolCall.id,
              message.id,
              options,
              descriptions,
              path,
            )

            meta['description'] = description
            enriched = true
          }
        }
      }

      // Persist enriched snapshot back to the store
      if (enriched && options.persistEvent) {
        options.persistEvent(event.sessionId, event.seq, snapshot)
      }
    }
  }

  return { events: modifiedEvents, descriptions }
}
