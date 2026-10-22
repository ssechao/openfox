// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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

const HASH = 'a'.repeat(64)

describe('MessageAttachments blob refs', () => {
  it('renders the image from the blob reference URL', () => {
    render(
      <MessageAttachments
        messageId="m1"
        attachments={[
          {
            id: 'att-b',
            filename: 'shot-b.png',
            mimeType: 'image/png',
            size: 70,
            blob: { hash: HASH, mime: 'image/png', size: 70 },
          },
        ]}
      />,
    )
    const img = screen.getByRole('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(blobUrl(HASH))
  })
})
