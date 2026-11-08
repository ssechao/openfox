import type { Dispatch, SetStateAction } from 'react'
import type { Attachment } from '@shared/types.js'

export function remainderAfterSend(current: string, sent: string): string {
  if (current === sent) return ''
  if (sent.length > 0 && current.startsWith(sent)) return current.slice(sent.length)
  return current
}

export function attachmentsAfterSend(current: Attachment[], sent: Attachment[]): Attachment[] {
  if (sent.length === 0) return current
  const sentIds = new Set(sent.map((item) => item.id))
  return current.filter((item) => !sentIds.has(item.id))
}

export function clearSentDraft(
  sentText: string,
  sentAttachments: Attachment[],
  setInput: Dispatch<SetStateAction<string>>,
  setAttachments: Dispatch<SetStateAction<Attachment[]>>,
): void {
  setInput((current) => remainderAfterSend(current, sentText))
  setAttachments((current) => attachmentsAfterSend(current, sentAttachments))
}

export function applySendResult(
  result: { ok: boolean; message?: string } | null | undefined,
  sentText: string,
  sentAttachments: Attachment[],
  setInput: Dispatch<SetStateAction<string>>,
  setAttachments: Dispatch<SetStateAction<Attachment[]>>,
  setErrorMessage: (message: string | null) => void,
): void {
  if (!result || result.ok) {
    clearSentDraft(sentText, sentAttachments, setInput, setAttachments)
    setErrorMessage(null)
    return
  }
  setErrorMessage(result.message ?? '')
}
