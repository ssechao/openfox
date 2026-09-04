// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { act } from 'react'
import { ChatFeedItems } from './ChatFeedItems'
import { FEED_REVEAL_EVENT } from './feed-window'
import { SETTINGS_KEYS, settingResource } from '../../lib/resources'
import { clearCache } from '../../lib/resourceCache'
import type { DisplayItem } from './groupMessages'

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = []
  callback: IntersectionObserverCallback

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    MockIntersectionObserver.instances.push(this)
  }

  observe() {}
  unobserve() {}
  disconnect() {}

  trigger() {
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

function msg(id: string, role: 'user' | 'assistant' = 'user', content = 'Hello'): DisplayItem {
  return {
    type: 'message',
    message: {
      id,
      role,
      content,
      timestamp: new Date().toISOString(),
      isStreaming: false,
    },
  }
}

describe('ChatFeedItems stable keys', () => {
  it('should preserve DOM node identity for shifted items', () => {
    const items = [msg('a', 'user', 'Alpha'), msg('b', 'user', 'Beta'), msg('c', 'user', 'Gamma')]

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => root.render(<ChatFeedItems displayItems={items} />))
    const nodeB = container.querySelector('[data-message-id="b"]')
    expect(nodeB).toBeTruthy()
    expect(nodeB?.textContent).toContain('Beta')

    // Simulate shift: 'a' drops out, from [a,b,c] to [b,c]
    const shifted = [msg('b', 'user', 'Beta'), msg('c', 'user', 'Gamma')]
    flushSync(() => root.render(<ChatFeedItems displayItems={shifted} />))

    const nodeB2 = container.querySelector('[data-message-id="b"]')
    expect(nodeB2).toBeTruthy()
    expect(nodeB).toBe(nodeB2)
  })

  it('should re-render when message content changes', () => {
    const items = [msg('a', 'user', 'Hello'), msg('b', 'user', 'World')]

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => root.render(<ChatFeedItems displayItems={items} />))
    const firstHtml = container.innerHTML

    flushSync(() =>
      root.render(<ChatFeedItems displayItems={[msg('a', 'user', 'Hello'), msg('b', 'user', 'Updated')]} />),
    )
    expect(container.innerHTML).not.toBe(firstHtml)
    expect(container.textContent).toContain('Updated')
  })

  it('keeps non-streaming message DOM intact when new message appended', () => {
    const items = [msg('a', 'user', 'First'), msg('b', 'user', 'Second')]

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => root.render(<ChatFeedItems displayItems={items} />))
    const nodeA = container.querySelector('[data-message-id="a"]')
    const nodeB = container.querySelector('[data-message-id="b"]')

    const items2 = [msg('a', 'user', 'First'), msg('b', 'user', 'Second'), msg('c', 'user', 'Third')]
    flushSync(() => root.render(<ChatFeedItems displayItems={items2} />))

    expect(container.querySelector('[data-message-id="a"]')).toBe(nodeA)
    expect(container.querySelector('[data-message-id="b"]')).toBe(nodeB)
    expect(container.textContent).toContain('Third')
  })
})

vi.mock('../../lib/api', () => ({ authFetch: vi.fn() }))

describe('ChatFeedItems default (virtualization off)', () => {
  beforeEach(() => {
    clearCache()
    settingResource.write('off', SETTINGS_KEYS.DISPLAY_FEED_VIRTUALIZATION)
  })

  it('mounts every item with no placeholders or sentinel when virtualization is off', () => {
    const items = Array.from({ length: 70 }, (_, i) => msg(`m${i}`, 'user', `Content ${i}`))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => root.render(<ChatFeedItems displayItems={items} />))

    expect(container.querySelector('[data-message-id="m0"]')).toBeTruthy()
    expect(container.querySelector('[data-message-id="m69"]')).toBeTruthy()
    expect(container.querySelectorAll('.feed-item')).toHaveLength(70)
    expect(container.querySelector('[data-placeholder]')).toBeNull()
    expect(container.querySelector('[data-testid="feed-sentinel"]')).toBeNull()
    expect(container.querySelector('[data-testid="feed-unmounted-hint"]')).toBeNull()
  })
})

describe('ChatFeedItems containment styling', () => {
  it('applies contain:layout to every wrapper and content-visibility to non-streaming wrappers when virtualization is off', () => {
    clearCache()
    const items = [msg('a', 'user', 'Alpha'), msg('b', 'assistant', 'Beta')]

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => root.render(<ChatFeedItems displayItems={items} />))

    const wrappers = container.querySelectorAll<HTMLElement>('[data-item-index]:not([data-placeholder])')
    expect(wrappers.length).toBe(2)
    // Every wrapper isolates its reflow with contain:layout.
    for (const wrapper of wrappers) {
      expect(wrapper.style.getPropertyValue('contain')).toBe('layout')
    }
    for (const wrapper of wrappers) {
      expect(wrapper.style.getPropertyValue('content-visibility')).toBe('auto')
      expect(wrapper.style.getPropertyValue('contain-intrinsic-size')).toBe('auto 200px')
    }
  })

  it('excludes every streaming item from content-visibility containment', () => {
    clearCache()
    const streaming = msg('streaming', 'assistant', 'Growing')
    if (streaming.type === 'message') streaming.message.isStreaming = true
    const items = [msg('before', 'user', 'Before'), streaming, msg('after', 'user', 'After')]

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => root.render(<ChatFeedItems displayItems={items} />))

    const wrappers = container.querySelectorAll<HTMLElement>('[data-item-index]:not([data-placeholder])')
    expect(wrappers[0]!.style.getPropertyValue('content-visibility')).toBe('auto')
    expect(wrappers[1]!.style.getPropertyValue('content-visibility')).toBe('')
    expect(wrappers[1]!.style.getPropertyValue('contain')).toBe('layout')
    expect(wrappers[2]!.style.getPropertyValue('content-visibility')).toBe('auto')
  })

  it('applies content-visibility containment to mounted items when virtualization is on', () => {
    clearCache()
    settingResource.write('true', SETTINGS_KEYS.DISPLAY_FEED_VIRTUALIZATION)
    const items = Array.from({ length: 34 }, (_, i) => msg(`m${i}`, 'user', `Content ${i}`))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => root.render(<ChatFeedItems displayItems={items} />))

    const wrappers = container.querySelectorAll<HTMLElement>('[data-item-index]:not([data-placeholder])')
    expect(wrappers.length).toBe(30)
    for (const wrapper of wrappers) {
      expect(wrapper.style.getPropertyValue('contain')).toBe('layout')
      expect(wrapper.style.getPropertyValue('content-visibility')).toBe('auto')
      expect(wrapper.style.getPropertyValue('contain-intrinsic-size')).toBe('auto 200px')
    }
    // Placeholders keep a fixed reserved height so the scroll position is
    // stable while older items are unmounted.
    const placeholders = container.querySelectorAll<HTMLElement>('[data-placeholder]')
    expect(placeholders.length).toBe(4)
    for (const placeholder of placeholders) {
      expect(placeholder.style.getPropertyValue('content-visibility')).toBe('auto')
      expect(placeholder.style.getPropertyValue('contain-intrinsic-size')).toBe('160px')
    }
  })
})

describe('ChatFeedItems auto virtualization', () => {
  beforeEach(() => {
    clearCache()
    MockIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('virtualizes automatically in auto mode when the feed exceeds the threshold', () => {
    const items = Array.from({ length: 51 }, (_, i) => msg(`m${i}`, 'user', `Content ${i}`))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => root.render(<ChatFeedItems displayItems={items} />))

    // 51 > 50: only the 30 most recent are mounted, the rest are placeholders
    expect(container.querySelectorAll('.feed-item')).toHaveLength(30)
    expect(container.querySelectorAll('[data-placeholder]')).toHaveLength(21)
    expect(container.querySelector('[data-testid="feed-sentinel"]')).toBeTruthy()
  })

  it('does not virtualize in auto mode at the threshold boundary', () => {
    const items = Array.from({ length: 50 }, (_, i) => msg(`m${i}`, 'user', `Content ${i}`))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => root.render(<ChatFeedItems displayItems={items} />))

    // 50 is not > 50: everything is mounted
    expect(container.querySelectorAll('.feed-item')).toHaveLength(50)
    expect(container.querySelectorAll('[data-placeholder]')).toHaveLength(0)
    expect(container.querySelector('[data-testid="feed-sentinel"]')).toBeNull()
  })

  it('virtualizes in auto mode for short feeds when forced on', () => {
    settingResource.write('on', SETTINGS_KEYS.DISPLAY_FEED_VIRTUALIZATION)
    const items = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, 'user', `Content ${i}`))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => root.render(<ChatFeedItems displayItems={items} />))

    // Forced on: the window is clamped to the available items, no placeholders
    expect(container.querySelectorAll('.feed-item')).toHaveLength(10)
    expect(container.querySelectorAll('[data-placeholder]')).toHaveLength(0)
  })

  it('never virtualizes when set to off, even on long feeds', () => {
    settingResource.write('off', SETTINGS_KEYS.DISPLAY_FEED_VIRTUALIZATION)
    const items = Array.from({ length: 80 }, (_, i) => msg(`m${i}`, 'user', `Content ${i}`))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => root.render(<ChatFeedItems displayItems={items} />))

    expect(container.querySelectorAll('.feed-item')).toHaveLength(80)
    expect(container.querySelectorAll('[data-placeholder]')).toHaveLength(0)
    expect(container.querySelector('[data-testid="feed-sentinel"]')).toBeNull()
  })

  it('maps the legacy true value to forced on', () => {
    settingResource.write('true', SETTINGS_KEYS.DISPLAY_FEED_VIRTUALIZATION)
    const items = Array.from({ length: 60 }, (_, i) => msg(`m${i}`, 'user', `Content ${i}`))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => root.render(<ChatFeedItems displayItems={items} />))

    expect(container.querySelectorAll('.feed-item')).toHaveLength(30)
    expect(container.querySelectorAll('[data-placeholder]')).toHaveLength(30)
  })

  it('maps the legacy false value to off', () => {
    settingResource.write('false', SETTINGS_KEYS.DISPLAY_FEED_VIRTUALIZATION)
    const items = Array.from({ length: 60 }, (_, i) => msg(`m${i}`, 'user', `Content ${i}`))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => root.render(<ChatFeedItems displayItems={items} />))

    expect(container.querySelectorAll('.feed-item')).toHaveLength(60)
    expect(container.querySelectorAll('[data-placeholder]')).toHaveLength(0)
  })
})

describe('ChatFeedItems progressive rendering', () => {
  beforeEach(() => {
    clearCache()
    settingResource.write('true', SETTINGS_KEYS.DISPLAY_FEED_VIRTUALIZATION)
    MockIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mounts only the most recent items first', () => {
    const items = Array.from({ length: 70 }, (_, i) => msg(`m${i}`, 'user', `Content ${i}`))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => root.render(<ChatFeedItems displayItems={items} />))

    // Only the 30 most recent are mounted: m40..m69
    expect(container.querySelector('[data-message-id="m0"]')).toBeNull()
    expect(container.querySelector('[data-message-id="m39"]')).toBeNull()
    expect(container.querySelector('[data-message-id="m40"]')).toBeTruthy()
    expect(container.querySelector('[data-message-id="m69"]')).toBeTruthy()
    expect(container.querySelectorAll('.feed-item')).toHaveLength(30)
    // The rest are unmounted placeholders
    expect(container.querySelectorAll('[data-placeholder]')).toHaveLength(40)
  })

  it('reveals older items in batches when the sentinel becomes visible', () => {
    const items = Array.from({ length: 70 }, (_, i) => msg(`m${i}`, 'user', `Content ${i}`))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => root.render(<ChatFeedItems displayItems={items} />))
    expect(container.querySelectorAll('.feed-item')).toHaveLength(30)
    expect(container.querySelector('[data-testid="feed-sentinel"]')).toBeTruthy()

    // Each reveal moves the window up by 20 items
    act(() => {
      MockIntersectionObserver.instances.at(-1)!.trigger()
    })
    expect(container.querySelectorAll('.feed-item')).toHaveLength(50)
    expect(container.querySelector('[data-message-id="m20"]')).toBeTruthy()

    act(() => {
      MockIntersectionObserver.instances.at(-1)!.trigger()
    })
    expect(container.querySelectorAll('.feed-item')).toHaveLength(70)
    expect(container.querySelector('[data-message-id="m0"]')).toBeTruthy()
    expect(container.querySelector('[data-placeholder]')).toBeNull()
    expect(container.querySelector('[data-testid="feed-sentinel"]')).toBeNull()
  })

  it('reveals up to a target index on the feed reveal event', () => {
    const items = Array.from({ length: 100 }, (_, i) => msg(`m${i}`, 'user', `Content ${i}`))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => root.render(<ChatFeedItems displayItems={items} />))
    expect(container.querySelectorAll('.feed-item')).toHaveLength(30)

    // Timeline navigation targets index 10 — everything up to it is revealed
    act(() => {
      window.dispatchEvent(new CustomEvent(FEED_REVEAL_EVENT, { detail: { index: 10 } }))
    })
    expect(container.querySelector('[data-message-id="m0"]')).toBeTruthy()
    expect(container.querySelectorAll('.feed-item')).toHaveLength(100)
  })

  it('keeps the window stable when new items are appended', () => {
    const items = Array.from({ length: 70 }, (_, i) => msg(`m${i}`, 'user', `Content ${i}`))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    flushSync(() => root.render(<ChatFeedItems displayItems={items} />))
    const nodeM69 = container.querySelector('[data-message-id="m69"]')

    const items2 = [...items, msg('m70', 'user', 'Newest')]
    flushSync(() => root.render(<ChatFeedItems displayItems={items2} />))

    // Newest item is mounted, previously mounted items keep their identity
    expect(container.querySelector('[data-message-id="m70"]')).toBeTruthy()
    expect(container.querySelector('[data-message-id="m69"]')).toBe(nodeM69)
    expect(container.querySelectorAll('.feed-item')).toHaveLength(31)
  })

  it('re-anchors to the latest window when a large batch arrives (initial load)', () => {
    const items = Array.from({ length: 70 }, (_, i) => msg(`m${i}`, 'user', `Content ${i}`))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    // Session arrives in chunks, like the real WS/REST load flow
    flushSync(() => root.render(<ChatFeedItems displayItems={items.slice(0, 16)} />))
    expect(container.querySelectorAll('.feed-item')).toHaveLength(16)

    act(() => {
      root.render(<ChatFeedItems displayItems={items} />)
    })
    // Bulk append re-anchors the window: only the 30 most recent are mounted
    expect(container.querySelectorAll('.feed-item')).toHaveLength(30)
    expect(container.querySelector('[data-message-id="m40"]')).toBeTruthy()
    expect(container.querySelector('[data-message-id="m0"]')).toBeNull()
    expect(container.querySelectorAll('[data-placeholder]')).toHaveLength(40)
  })

  it('resets userScrolled state when sessionId changes', () => {
    const items = Array.from({ length: 70 }, (_, i) => msg(`m${i}`, 'user', `Content ${i}`))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const scrollListeners: Array<() => void> = []
    const viewport = {
      scrollTop: 0,
      addEventListener: (_: string, cb: () => void) => scrollListeners.push(cb),
      removeEventListener: () => {},
    }
    const scrollContainerRef = {
      current: {
        osInstance: () => ({ elements: () => ({ viewport }) }),
        getElement: () => null,
      },
    } as never

    // Load session A and simulate user scrolling into history
    flushSync(() =>
      root.render(
        <ChatFeedItems
          displayItems={items.slice(0, 16)}
          sessionId="session-a"
          scrollContainerRef={scrollContainerRef}
        />,
      ),
    )
    act(() => {
      root.render(<ChatFeedItems displayItems={items} sessionId="session-a" scrollContainerRef={scrollContainerRef} />)
    })
    act(() => {
      viewport.scrollTop = 500
      for (const cb of scrollListeners) cb()
      MockIntersectionObserver.instances.at(-1)!.trigger()
      MockIntersectionObserver.instances.at(-1)!.trigger()
    })
    expect(container.querySelectorAll('.feed-item')).toHaveLength(70)

    // Switch to session B — userScrolled must be reset; window re-anchors
    const itemsB = Array.from({ length: 70 }, (_, i) => msg(`b${i}`, 'user', `B ${i}`))
    act(() => {
      root.render(<ChatFeedItems displayItems={itemsB} sessionId="session-b" scrollContainerRef={scrollContainerRef} />)
    })
    expect(container.querySelectorAll('.feed-item')).toHaveLength(30)
    expect(container.querySelector('[data-message-id="b69"]')).toBeTruthy()
    expect(container.querySelector('[data-message-id="b0"]')).toBeNull()

    // A bulk batch on session B also re-anchors (userScrolled was reset)
    const bigBatch = Array.from({ length: 100 }, (_, i) => msg(`b${i}`, 'user', `B ${i}`))
    act(() => {
      root.render(
        <ChatFeedItems displayItems={bigBatch} sessionId="session-b" scrollContainerRef={scrollContainerRef} />,
      )
    })
    expect(container.querySelectorAll('.feed-item')).toHaveLength(30)
    expect(container.querySelector('[data-message-id="b99"]')).toBeTruthy()
    expect(container.querySelector('[data-message-id="b0"]')).toBeNull()
  })

  it('does not re-anchor when the user has scrolled into history (reconnect replay)', () => {
    const items = Array.from({ length: 70 }, (_, i) => msg(`m${i}`, 'user', `Content ${i}`))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    // OS viewport mock: scrollTop > 4 means the user scrolled up
    const scrollListeners: Array<() => void> = []
    const viewport = {
      scrollTop: 0,
      addEventListener: (_: string, cb: () => void) => scrollListeners.push(cb),
      removeEventListener: () => {},
    }
    const scrollContainerRef = {
      current: {
        osInstance: () => ({ elements: () => ({ viewport }) }),
        getElement: () => null,
      },
    } as never

    // Initial load re-anchors to the bottom
    flushSync(() =>
      root.render(<ChatFeedItems displayItems={items.slice(0, 16)} scrollContainerRef={scrollContainerRef} />),
    )
    act(() => {
      root.render(<ChatFeedItems displayItems={items} scrollContainerRef={scrollContainerRef} />)
    })
    expect(container.querySelectorAll('.feed-item')).toHaveLength(30)

    // User scrolls up (fires the scroll listener) and reveals everything
    act(() => {
      viewport.scrollTop = 500
      for (const cb of scrollListeners) cb()
      MockIntersectionObserver.instances.at(-1)!.trigger()
      MockIntersectionObserver.instances.at(-1)!.trigger()
    })
    expect(container.querySelectorAll('.feed-item')).toHaveLength(70)
    expect(container.querySelector('[data-message-id="m0"]')).toBeTruthy()

    // Reconnect replay delivers a large batch — the window must NOT jump back down
    const replayItems = Array.from({ length: 100 }, (_, i) => msg(`r${i}`, 'user', `Replay ${i}`))
    act(() => {
      root.render(<ChatFeedItems displayItems={replayItems} scrollContainerRef={scrollContainerRef} />)
    })
    // Window stays anchored at the top: all 100 items mounted, no placeholders
    expect(container.querySelectorAll('.feed-item')).toHaveLength(100)
    expect(container.querySelector('[data-message-id="r0"]')).toBeTruthy()
    expect(container.querySelector('[data-placeholder]')).toBeNull()
  })
})
