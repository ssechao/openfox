// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { blobUrl } from '@shared/blob.js'

vi.mock('../../stores/session', () => ({
  useSessionStore: (sel: (s: { visionFallbackByMessage: Record<string, never>; messages: [] }) => unknown) =>
    sel({ visionFallbackByMessage: {}, messages: [] }),
}))
vi.mock('../../hooks/useT', () => ({
  useT: () => (v: { en: string }) => v.en,
}))
vi.mock('./ImageModal', () => ({ ImageModal: () => null }))

import { MessageAttachments } from './MessageAttachments'
import { AttachmentPreview } from './AttachmentPreview'

const HASH = 'a'.repeat(64)
const TOKEN = 'network-session-token'

const attachment = {
  id: 'att-b',
  filename: 'shot-b.png',
  mimeType: 'image/png',
  size: 70,
  blob: { hash: HASH, mime: 'image/png', size: 70 },
}

describe('MessageAttachments blob refs', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('renders the image from the blob URL with the session token query', () => {
    localStorage.setItem('openfox_token', TOKEN)
    render(<MessageAttachments messageId="m1" attachments={[attachment]} />)
    const img = screen.getByRole('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(blobUrl(HASH, TOKEN))
  })

  it('renders AttachmentPreview from the same authenticated blob URL', () => {
    localStorage.setItem('openfox_token', TOKEN)
    render(<AttachmentPreview attachment={attachment} onRemove={() => undefined} />)
    const img = screen.getByRole('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(blobUrl(HASH, TOKEN))
  })
})
