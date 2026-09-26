/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PluginModelMeta } from './PluginModelMeta'
import { useLocaleStore } from '../../stores/locale'

describe('PluginModelMeta', () => {
  beforeEach(() => {
    useLocaleStore.setState({ locale: 'en' })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders nothing without metadata', () => {
    const { container } = render(<PluginModelMeta metadata={undefined} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders badges when present', () => {
    render(
      <PluginModelMeta
        metadata={{
          badges: [{ label: { en: 'Cheap', fr: 'Économique' }, tone: 'success' }],
        }}
      />,
    )
    expect(screen.getByText('Cheap')).toBeDefined()
  })

  it('localizes badges in French', () => {
    useLocaleStore.setState({ locale: 'fr' })
    render(<PluginModelMeta metadata={{ badges: [{ label: { en: 'Cheap', fr: 'Économique' }, tone: 'success' }] }} />)
    expect(screen.getByText('Économique')).toBeDefined()
  })
})
