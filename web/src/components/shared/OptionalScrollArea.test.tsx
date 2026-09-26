// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_KEYS, settingResource } from '../../lib/resources'
import { clearCache } from '../../lib/resourceCache'
import { OptionalScrollArea } from './OptionalScrollArea'

vi.mock('../../lib/api', () => ({ authFetch: vi.fn() }))

describe('OptionalScrollArea', () => {
  beforeEach(() => {
    clearCache()
  })

  afterEach(cleanup)

  it('starts as a plain clipped container rather than mounting a scroll area', () => {
    const { container } = render(<OptionalScrollArea>content</OptionalScrollArea>)

    expect(container.textContent).toContain('content')
    expect(container.querySelector('.scrollbar-hidden')).not.toBeNull()
  })

  it('keeps code-block scrollbars styled by default', () => {
    const { container } = render(<OptionalScrollArea scope="codeBlocks">content</OptionalScrollArea>)

    expect(container.querySelector('[data-native-scroll-area]')).toBeNull()
  })

  it('renders a native scrollable div when the toolCalls scope is enabled', () => {
    settingResource.write('true', SETTINGS_KEYS.DISPLAY_USE_NATIVE_SCROLLBARS)
    const { container } = render(<OptionalScrollArea>content</OptionalScrollArea>)

    expect(container.querySelector('.overflow-y-auto')).not.toBeNull()
    // Native mode shows real scrollbars, so it must not be the hidden-scrollbar
    // lazy fallback.
    expect(container.querySelector('.scrollbar-hidden')).toBeNull()
  })

  it('maps the horizontal flag to overflow-x-auto in native mode', () => {
    settingResource.write('true', SETTINGS_KEYS.DISPLAY_USE_NATIVE_SCROLLBARS)
    const { container } = render(<OptionalScrollArea horizontal>content</OptionalScrollArea>)

    expect(container.querySelector('.overflow-x-auto')).not.toBeNull()
  })

  it('passes through className and style in native mode', () => {
    settingResource.write('true', SETTINGS_KEYS.DISPLAY_USE_NATIVE_SCROLLBARS)
    const { container } = render(
      <OptionalScrollArea className="max-h-32" style={{ color: 'red' }}>
        content
      </OptionalScrollArea>,
    )

    const div = container.querySelector('.overflow-y-auto')
    expect(div?.className).toContain('max-h-32')
    expect((div as HTMLElement | null)?.style.color).toBe('red')
  })

  it('keeps scopes independent: codeBlocks on does not affect an explicit toolCalls opt-out', () => {
    settingResource.write('false', SETTINGS_KEYS.DISPLAY_USE_NATIVE_SCROLLBARS)
    settingResource.write('true', SETTINGS_KEYS.DISPLAY_USE_NATIVE_SCROLLBARS_CODE_BLOCKS)
    const { container } = render(
      <div>
        <OptionalScrollArea>tool calls</OptionalScrollArea>
        <OptionalScrollArea scope="codeBlocks">code blocks</OptionalScrollArea>
      </div>,
    )

    // The codeBlocks pane renders natively; the toolCalls pane stays lazy.
    expect(container.querySelectorAll('.scrollbar-hidden')).toHaveLength(1)
    expect(container.querySelector('.scrollbar-hidden')?.textContent).toBe('tool calls')
  })
})

/** Give a plain div the geometry happy-dom does not compute. */
function stubOverflow(
  element: HTMLElement,
  { scrollHeight = 0, clientHeight = 0, scrollWidth = 0, clientWidth = 0 } = {},
) {
  Object.defineProperty(element, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(element, 'clientHeight', { value: clientHeight, configurable: true })
  Object.defineProperty(element, 'scrollWidth', { value: scrollWidth, configurable: true })
  Object.defineProperty(element, 'clientWidth', { value: clientWidth, configurable: true })
}

describe('OptionalScrollArea lazy upgrade', () => {
  beforeEach(() => {
    clearCache()
  })

  afterEach(cleanup)

  const fallback = (container: HTMLElement): HTMLElement => {
    const element = container.querySelector('.scrollbar-hidden')
    if (!element) throw new Error('lazy fallback not found')
    return element as HTMLElement
  }

  it('upgrades to the styled scroll area on hover when the content can scroll', () => {
    const { container } = render(<OptionalScrollArea>content</OptionalScrollArea>)
    stubOverflow(fallback(container), { scrollHeight: 500, clientHeight: 200 })

    fireEvent.mouseEnter(fallback(container))

    expect(container.querySelector('.scrollbar-hidden')).toBeNull()
    expect(container.textContent).toContain('content')
  })

  it('stays lazy while the content fits', () => {
    const { container } = render(<OptionalScrollArea>content</OptionalScrollArea>)
    stubOverflow(fallback(container), { scrollHeight: 200, clientHeight: 200 })

    fireEvent.mouseEnter(fallback(container))

    expect(container.querySelector('.scrollbar-hidden')).not.toBeNull()
  })

  it('upgrades on a later hover once the content has grown past the box', () => {
    const { container } = render(<OptionalScrollArea>content</OptionalScrollArea>)
    stubOverflow(fallback(container), { scrollHeight: 200, clientHeight: 200 })
    fireEvent.mouseEnter(fallback(container))
    expect(container.querySelector('.scrollbar-hidden')).not.toBeNull()

    // A streamed tool output grows the content after the first hover.
    stubOverflow(fallback(container), { scrollHeight: 900, clientHeight: 200 })
    fireEvent.mouseEnter(fallback(container))

    expect(container.querySelector('.scrollbar-hidden')).toBeNull()
  })

  it('measures width for horizontal panes', () => {
    const { container } = render(<OptionalScrollArea horizontal>content</OptionalScrollArea>)
    stubOverflow(fallback(container), { scrollWidth: 900, clientWidth: 200 })

    fireEvent.mouseEnter(fallback(container))

    expect(container.querySelector('.scrollbar-hidden')).toBeNull()
  })

  it('upgrades on touch, which never fires a hover', () => {
    const { container } = render(<OptionalScrollArea>content</OptionalScrollArea>)
    stubOverflow(fallback(container), { scrollHeight: 500, clientHeight: 200 })

    fireEvent.touchStart(fallback(container))

    expect(container.querySelector('.scrollbar-hidden')).toBeNull()
  })

  it('carries the scroll offset across the upgrade so the pane does not jump', () => {
    const { container } = render(<OptionalScrollArea>content</OptionalScrollArea>)
    const element = fallback(container)
    stubOverflow(element, { scrollHeight: 500, clientHeight: 200 })
    element.scrollTop = 120

    fireEvent.wheel(element)
    fireEvent.mouseEnter(element)

    const viewport = container.querySelector('div > div') as HTMLElement
    expect(viewport?.scrollTop).toBe(120)
  })
})
