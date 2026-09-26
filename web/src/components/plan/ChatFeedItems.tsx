import { memo, useEffect, useRef, useState } from 'react'
import type { OverlayScrollbarsComponentRef } from 'overlayscrollbars-react'
import type { DisplayItem } from './groupMessages.js'
import { ChatMessage } from './ChatMessage'
import { AssistantMessage } from './AssistantMessage'
import { SubAgentContainer } from './SubAgentContainer'
import { FeedDivider } from './FeedDivider'
import { FEED_REVEAL_EVENT } from './feed-window'
import { useDisplaySettings } from '../../hooks/useDisplaySettings'
import { useT } from '../../hooks/useT'

const PLACEHOLDER_STYLE = { contentVisibility: 'auto', containIntrinsicSize: '160px', minHeight: '160px' } as const
// content-visibility:auto skips layout/paint for off-screen messages, which is
// what makes a resize fast on long feeds (without it the browser reflows every
// message). contain-intrinsic-size:auto remembers each element's last-measured
// height so the reserved space is stable. Every streaming item is excluded:
// its content changes continuously, so a frozen intrinsic size would
// leave stale phantom gaps. contain:layout additionally isolates each
// wrapper's reflow so it never cascades across the feed.
const ITEM_CONTAINMENT_STYLE = { contentVisibility: 'auto', containIntrinsicSize: 'auto 200px' } as const
const WRAPPER_CONTAIN_STYLE = { contain: 'layout' } as const
// Hoisted so the two variants are allocated once, not per item per render.
const WRAPPER_CONTAINED_STYLE = { ...WRAPPER_CONTAIN_STYLE, ...ITEM_CONTAINMENT_STYLE } as const

// Bottom-anchored virtualization: only the most recent items are mounted at
// load, older items are revealed in batches as the user scrolls up.
const INITIAL_RENDER_COUNT = 30
const REVEAL_BATCH_SIZE = 20
const REVEAL_MARGIN = 10
const BULK_APPEND_THRESHOLD = 5
// In 'auto' mode, feeds longer than this are virtualized automatically.
export const AUTO_VIRTUALIZE_THRESHOLD = 50
// How close to the top the feed has to get before older items are revealed.
// A "scrollTop === 0" trigger is useless: the feed is pinned to the bottom, so
// reaching the hard stop means traversing every placeholder first — and the
// unmounted hint is already visible well before that.
const REVEAL_TOP_THRESHOLD_PX = 240

interface ChatFeedItemsProps {
  displayItems: DisplayItem[]
  highlightedMessageId?: string | null
  sessionId?: string | null
  scrollContainerRef?: React.RefObject<OverlayScrollbarsComponentRef<'div'> | null>
  /**
   * Whether auto-scroll is currently pinned to the newest items. This is the
   * authoritative "is the user following the stream?" signal: it is already
   * false whenever the user scrolls into history, and — unlike a scroll
   * position check — it is not tripped by auto-scroll's own programmatic
   * scrolls or by content growing between two animation frames.
   */
  isAutoScrollActive?: boolean
  showThinking?: boolean
  showVerboseToolOutput?: boolean
  showStats?: boolean
  showAgentDefinitions?: boolean
  showWorkflowBars?: boolean
  /**
   * Overrides the feedVirtualization setting for the windowing (hint,
   * placeholders, reveal triggers). Containment still follows the setting.
   * Top-anchored views (readonly full history) pass false: they open at
   * scrollTop 0, where the bottom-anchored "scroll up to load older" reveal
   * can never fire.
   */
  virtualization?: boolean
}

function itemKey(item: DisplayItem): string {
  if (item.type === 'context-divider') return `ctx-${item.windowSequence}`
  if (item.type === 'subagent') return item.messages[0]?.id ?? item.subAgentId
  return item.message.id
}

export const ChatFeedItems = memo(function ChatFeedItems({
  displayItems,
  highlightedMessageId = null,
  sessionId,
  scrollContainerRef,
  isAutoScrollActive = true,
  showThinking = true,
  showVerboseToolOutput = true,
  showStats = true,
  showAgentDefinitions = true,
  showWorkflowBars = true,
  virtualization,
}: ChatFeedItemsProps) {
  const t = useT()
  const totalItems = displayItems.length
  const { feedVirtualizationMode } = useDisplaySettings()
  // Virtualization is on by default for long feeds (auto mode), forced by
  // 'on', and disabled by 'off'. The `virtualization` prop overrides the
  // setting for the windowing (hint, placeholders, reveal triggers).
  const virtualized =
    virtualization ??
    (feedVirtualizationMode === 'on' || (feedVirtualizationMode === 'auto' && totalItems > AUTO_VIRTUALIZE_THRESHOLD))
  // Absolute index of the first mounted item. New items appended at the end
  // (streaming) keep the window stable — only the reveal moves it up.
  const [startIndex, setStartIndex] = useState(() => Math.max(0, totalItems - INITIAL_RENDER_COUNT))
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const prevItemCountRef = useRef(displayItems.length)
  const userScrolledRef = useRef(false)
  const displayStart = virtualized ? startIndex : 0
  // Every wrapper isolates its reflow with contain:layout. Non-streaming
  // wrappers also get content-visibility so off-screen messages skip
  // layout/paint without freezing any active stream's intrinsic height.
  const wrapperStyle = (isStreaming: boolean | undefined) =>
    isStreaming ? WRAPPER_CONTAIN_STYLE : WRAPPER_CONTAINED_STYLE

  // Reset the virtual window when switching sessions.
  useEffect(() => {
    if (!virtualized) return
    setStartIndex(Math.max(0, displayItems.length - INITIAL_RENDER_COUNT))
    userScrolledRef.current = false
  }, [sessionId, virtualized])

  // Re-anchor the window to the newest items. This has to cover three cases:
  // a bulk history load, a session that started empty and grew by single
  // streaming appends (where the initial `totalItems - INITIAL_RENDER_COUNT`
  // was clamped to 0 and would otherwise never establish a window), and a
  // window that drifted past the render count as items accumulated.
  // Only while the feed follows the bottom: re-anchoring under a reader who
  // scrolled into history would yank the viewport away.
  useEffect(() => {
    const prev = prevItemCountRef.current
    prevItemCountRef.current = displayItems.length
    if (!virtualized) return
    // Only while the feed follows the bottom: re-anchoring under a reader who
    // scrolled into history would yank the viewport away.
    if (!isAutoScrollActive || userScrolledRef.current) return
    const length = displayItems.length
    const bulkAppend = length - prev >= BULK_APPEND_THRESHOLD
    setStartIndex((current) => {
      const drifted = length - current > INITIAL_RENDER_COUNT
      if (!bulkAppend && !drifted) return current
      return Math.max(0, length - INITIAL_RENDER_COUNT)
    })
  }, [displayItems.length, virtualized, isAutoScrollActive])

  // Clamp when items are removed (truncation, session switch).
  useEffect(() => {
    if (!virtualized) return
    if (startIndex > 0 && startIndex >= displayItems.length) {
      setStartIndex(Math.max(0, displayItems.length - INITIAL_RENDER_COUNT))
    }
  }, [displayItems.length, startIndex, virtualized])

  // Reveal older items in batches while the sentinel approaches the viewport.
  // The bottom-expanded rootMargin triggers before the user reaches the
  // placeholder region, so scrolling up never exposes gaps.
  useEffect(() => {
    if (!virtualized) return
    if (startIndex <= 0 || typeof IntersectionObserver === 'undefined') return
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setStartIndex((index) => Math.max(0, index - REVEAL_BATCH_SIZE))
        }
      },
      { rootMargin: '0px 0px 300px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [startIndex, virtualized])

  // When the user reaches the very top, keep revealing until everything is
  // mounted — the sentinel can end up below remaining placeholders, out of the
  // observer margin, leaving unmounted gaps at the top of the list. Only runs
  // after the user has scrolled the container (not during the initial
  // bottom-anchor scroll).
  const startIndexRef = useRef(startIndex)
  startIndexRef.current = startIndex

  useEffect(() => {
    if (!virtualized) return
    // Resolve the viewport inside the handler, not while attaching. The
    // OverlayScrollbars instance is created in a passive effect of the feed's
    // ScrollArea, and React runs child effects first — so at attach time
    // `osInstance()` is still undefined and the listener would silently never
    // be added. A capture listener on the document sees every scroll event,
    // including the feed viewport's (scroll events do not bubble).
    const onScroll = (event: Event) => {
      const viewport = scrollContainerRef?.current?.osInstance?.()?.elements().viewport
      if (!viewport || event.target !== viewport) return
      if (viewport.scrollTop > REVEAL_TOP_THRESHOLD_PX) {
        userScrolledRef.current = true
        return
      }
      if (startIndexRef.current > 0) {
        setStartIndex((index) => Math.max(0, index - REVEAL_BATCH_SIZE))
      }
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => document.removeEventListener('scroll', onScroll, { capture: true })
  }, [scrollContainerRef, virtualized])

  useEffect(() => {
    if (!virtualized) return
    if (startIndex <= 0 || !userScrolledRef.current) return
    const container = scrollContainerRef?.current
    const viewport = container?.osInstance?.()?.elements().viewport
    if (viewport && viewport.scrollTop <= REVEAL_TOP_THRESHOLD_PX) {
      setStartIndex((index) => Math.max(0, index - REVEAL_BATCH_SIZE))
    }
  }, [startIndex, scrollContainerRef, virtualized])

  // Timeline navigation: reveal up to a target index when asked. This is the
  // only active reveal path — highlightedMessageId (ChatFeedItems) has no
  // non-null caller today, so any future highlight must reveal the target via
  // this event first (see PlanPanel's MessageList usage).
  useEffect(() => {
    if (!virtualized) return
    const onRevealRequest = (event: Event) => {
      const index = (event as CustomEvent<{ index: number }>).detail?.index
      if (typeof index !== 'number') return
      setStartIndex((current) => Math.min(current, Math.max(0, index - REVEAL_MARGIN)))
    }
    window.addEventListener(FEED_REVEAL_EVENT, onRevealRequest)
    return () => window.removeEventListener(FEED_REVEAL_EVENT, onRevealRequest)
  }, [virtualized])

  const visibleItems = displayItems.slice(displayStart)

  return (
    <>
      {displayStart > 0 && (
        <>
          <div
            className="flex items-center justify-center gap-2 py-3 text-xs text-text-muted"
            data-testid="feed-unmounted-hint"
          >
            {t(
              {
                en: { one: 'Scroll up to load {{count}} older item', other: 'Scroll up to load {{count}} older items' },
                fr: {
                  one: 'Faites défiler vers le haut pour charger {{count}} élément plus ancien',
                  other: 'Faites défiler vers le haut pour charger {{count}} éléments plus anciens',
                },
              },
              { count: displayStart },
            )}
          </div>
          {Array.from({ length: displayStart }, (_, i) => (
            <div key={`ph-${i}`} data-item-index={i} data-placeholder style={PLACEHOLDER_STYLE} />
          ))}
          <div ref={sentinelRef} data-testid="feed-sentinel" style={{ height: 1 }} />
        </>
      )}
      {visibleItems.map((item, index) => {
        const displayIndex = displayStart + index
        if (item.type === 'context-divider') {
          return (
            <div key={itemKey(item)} data-item-index={displayIndex} className="feed-item px-2 @md:px-4">
              <FeedDivider label={t({ en: 'Earlier context summarized', fr: 'Contexte antérieur résumé' })} />
            </div>
          )
        }

        if (item.type === 'subagent') {
          const groupIsStreaming = item.messages.some((m) => m.isStreaming)
          return (
            <div
              key={itemKey(item)}
              data-item-index={displayIndex}
              className="px-2 @md:px-4"
              style={wrapperStyle(groupIsStreaming)}
            >
              <SubAgentContainer
                messages={item.messages}
                subAgentType={item.subAgentType}
                subAgentId={item.subAgentId}
                isStreaming={groupIsStreaming}
              />
            </div>
          )
        }

        const message = item.message
        if (message.role === 'assistant') {
          return (
            <div
              key={itemKey(item)}
              data-item-index={displayIndex}
              className="px-2 @md:px-4"
              style={wrapperStyle(message.isStreaming)}
            >
              <AssistantMessage
                message={message}
                showStats={showStats}
                showThinking={showThinking}
                showVerboseToolOutput={showVerboseToolOutput}
                sessionId={sessionId ?? undefined}
              />
            </div>
          )
        }

        const skipAutoPrompt = !showAgentDefinitions && message.messageKind === 'auto-prompt'
        const skipWorkflow =
          !showWorkflowBars && (message.messageKind === 'workflow-started' || message.messageKind === 'task-completed')
        if (skipAutoPrompt || skipWorkflow) {
          return null
        }

        return (
          <div
            key={itemKey(item)}
            data-item-index={displayIndex}
            className="px-2 @md:px-4"
            style={wrapperStyle(message.isStreaming)}
          >
            <div
              data-message-id={message.id}
              className={highlightedMessageId === message.id ? 'rounded animate-highlight-fade' : undefined}
            >
              <ChatMessage
                message={message}
                messageId={message.id}
                sessionId={sessionId ?? undefined}
                isLastAssistantMessage={false}
              />
            </div>
          </div>
        )
      })}
    </>
  )
})
