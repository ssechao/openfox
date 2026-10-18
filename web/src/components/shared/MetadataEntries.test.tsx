// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MetadataEntries } from './MetadataEntries'

afterEach(cleanup)

describe('MetadataEntries', () => {
  it('shows the complete decoded entry in a left-side tooltip without a native title', async () => {
    const decodedDescription = `A & B finding with a long explanation ${'that must remain readable '.repeat(30)}`.trim()
    const description = decodedDescription.replace('&', '&amp;')
    render(<MetadataEntries entries={[{ id: 'finding-7', description, status: 'open' }]} title="Review Findings" />)

    const visibleText = screen.getByText(/A & B finding with a long explanation/)
    const trigger = visibleText.parentElement as HTMLElement
    expect(trigger).not.toHaveAttribute('title')

    fireEvent.mouseEnter(trigger)

    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(`[finding-7] ${decodedDescription}`))
    expect(screen.getByRole('tooltip')).toHaveClass('max-w-lg')
  })
})
