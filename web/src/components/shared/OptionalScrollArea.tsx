import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { OverlayScrollbarsComponentRef } from 'overlayscrollbars-react'
import { ScrollArea } from './ScrollArea'
import { useDisplaySettings } from '../../hooks/useDisplaySettings'

interface OptionalScrollAreaProps {
  children?: ReactNode
  className?: string
  horizontal?: boolean
  style?: CSSProperties
  // Which performance setting controls this area. Code blocks render markdown
  // (often large dumps), so they're tuned independently of tool call panes.
  scope?: 'toolCalls' | 'codeBlocks'
}

/**
 * Styled ScrollArea by default, but only where it can matter.
 *
 * An OverlayScrollbars instance is not a passive CSS skin: each one installs a
 * MutationObserver over its host subtree plus two ResizeObservers. A chat feed
 * mounts hundreds of these panes (tool call panes, code blocks) and most never
 * overflow — and a pane that cannot scroll shows no scrollbar at all, because
 * `autoHide` keeps it hidden until the user scrolls. So until the user engages
 * with a pane, a plain clipped container is visually identical and costs
 * nothing.
 *
 * The first hover/touch/wheel upgrades the pane to the styled ScrollArea if —
 * and only if — its content can actually scroll. The fallback hides its native
 * scrollbar, so there is no flash of a native bar while it waits, and the box
 * geometry is identical either way.
 *
 * When the matching performance setting is on, a plain native-scrolling div is
 * used instead (cheaper, but native scrollbars look different on some
 * platforms). The decision happens at render time, so toggling the setting
 * applies immediately to mounted content.
 */
export function OptionalScrollArea({
  children,
  className = '',
  horizontal = false,
  style,
  scope = 'toolCalls',
}: OptionalScrollAreaProps) {
  const { useNativeScrollbars, useNativeScrollbarsCodeBlocks } = useDisplaySettings()
  const native = scope === 'codeBlocks' ? useNativeScrollbarsCodeBlocks : useNativeScrollbars

  if (native) {
    const overflowClass = horizontal ? 'overflow-x-auto' : 'overflow-y-auto'
    return (
      <div data-native-scroll-area="" className={`${overflowClass} ${className}`.trim()} style={style}>
        {children}
      </div>
    )
  }

  return (
    <LazyScrollArea horizontal={horizontal} className={className} style={style}>
      {children}
    </LazyScrollArea>
  )
}

interface LazyScrollAreaProps {
  children: ReactNode
  className: string
  horizontal: boolean
  style?: CSSProperties
}

function LazyScrollArea({ children, className, horizontal, style }: LazyScrollAreaProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const scrollAreaRef = useRef<OverlayScrollbarsComponentRef<'div'>>(null)
  const [upgraded, setUpgraded] = useState(false)
  const savedOffsetRef = useRef<{ top: number; left: number } | null>(null)

  // Carry over whatever the plain container had already scrolled to, so an
  // upgrade that lands mid-gesture cannot jump the content back to the top.
  useEffect(() => {
    if (!upgraded) return
    const saved = savedOffsetRef.current
    savedOffsetRef.current = null
    if (!saved) return
    const viewport = scrollAreaRef.current?.osInstance?.()?.elements().viewport
    if (!viewport) return
    viewport.scrollTop = saved.top
    viewport.scrollLeft = saved.left
  }, [upgraded])

  const upgradeIfScrollable = () => {
    const host = hostRef.current
    if (!host) return
    const scrollable = horizontal ? host.scrollWidth > host.clientWidth : host.scrollHeight > host.clientHeight
    if (!scrollable) return
    savedOffsetRef.current = { top: host.scrollTop, left: host.scrollLeft }
    setUpgraded(true)
  }

  if (upgraded) {
    return (
      <ScrollArea ref={scrollAreaRef} horizontal={horizontal} className={className} style={style}>
        {children}
      </ScrollArea>
    )
  }

  const overflowClass = horizontal ? 'overflow-x-auto' : 'overflow-y-auto'
  return (
    <div
      ref={hostRef}
      className={`${overflowClass} scrollbar-hidden ${className}`.trim()}
      style={style}
      onMouseEnter={upgradeIfScrollable}
      onTouchStart={upgradeIfScrollable}
      onWheel={upgradeIfScrollable}
    >
      {children}
    </div>
  )
}
