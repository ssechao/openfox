import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

type TooltipPosition = 'top' | 'bottom' | 'left' | 'right'

interface TooltipProps {
  content: string
  children: React.ReactNode
  position?: TooltipPosition
  delay?: number
  triggerClassName?: string
  className?: string
  enabled?: boolean
}

interface TooltipPlacement {
  top: number
  left: number
  maxHeight: number
  maxWidth?: number
  measured: boolean
}

const VIEWPORT_MARGIN = 8
const TOOLTIP_GAP = 8

function viewportMaxHeight(): number {
  return Math.max(0, window.innerHeight - VIEWPORT_MARGIN * 2)
}

function opposite(position: TooltipPosition): TooltipPosition {
  switch (position) {
    case 'top':
      return 'bottom'
    case 'bottom':
      return 'top'
    case 'left':
      return 'right'
    case 'right':
      return 'left'
  }
}

function coordinates(
  position: TooltipPosition,
  trigger: DOMRect,
  tooltipWidth: number,
  tooltipHeight: number,
): { top: number; left: number } {
  switch (position) {
    case 'top':
      return {
        top: trigger.top - TOOLTIP_GAP - tooltipHeight,
        left: trigger.left + (trigger.width - tooltipWidth) / 2,
      }
    case 'bottom':
      return {
        top: trigger.bottom + TOOLTIP_GAP,
        left: trigger.left + (trigger.width - tooltipWidth) / 2,
      }
    case 'left':
      return {
        top: trigger.top + (trigger.height - tooltipHeight) / 2,
        left: trigger.left - TOOLTIP_GAP - tooltipWidth,
      }
    case 'right':
      return {
        top: trigger.top + (trigger.height - tooltipHeight) / 2,
        left: trigger.right + TOOLTIP_GAP,
      }
  }
}

function fitsPrimaryAxis(
  position: TooltipPosition,
  point: { top: number; left: number },
  tooltipWidth: number,
  tooltipHeight: number,
): boolean {
  switch (position) {
    case 'top':
      return point.top >= VIEWPORT_MARGIN
    case 'bottom':
      return point.top + tooltipHeight <= window.innerHeight - VIEWPORT_MARGIN
    case 'left':
      return point.left >= VIEWPORT_MARGIN
    case 'right':
      return point.left + tooltipWidth <= window.innerWidth - VIEWPORT_MARGIN
  }
}

export function Tooltip({
  content,
  children,
  position = 'top',
  delay = 200,
  triggerClassName = 'inline-flex',
  className = 'max-w-sm',
  enabled = true,
}: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [placement, setPlacement] = useState<TooltipPlacement>(() => ({
    top: VIEWPORT_MARGIN,
    left: VIEWPORT_MARGIN,
    maxHeight: viewportMaxHeight(),
    measured: false,
  }))
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  useLayoutEffect(() => {
    if (!visible) return

    const updatePlacement = () => {
      const trigger = triggerRef.current
      const tooltip = tooltipRef.current
      if (!trigger || !tooltip) return

      const maxHeight = viewportMaxHeight()
      const viewportMaxWidth = Math.max(0, window.innerWidth - VIEWPORT_MARGIN * 2)
      const tooltipRect = tooltip.getBoundingClientRect()

      if (tooltipRect.width > viewportMaxWidth && placement.maxWidth !== viewportMaxWidth) {
        setPlacement((current) => ({
          ...current,
          maxHeight,
          maxWidth: viewportMaxWidth,
          measured: false,
        }))
        return
      }

      const triggerRect = trigger.getBoundingClientRect()
      const tooltipWidth = Math.min(tooltipRect.width, viewportMaxWidth)
      const tooltipHeight = Math.min(tooltipRect.height, maxHeight)
      let resolvedPosition = position
      let point = coordinates(resolvedPosition, triggerRect, tooltipWidth, tooltipHeight)

      if (!fitsPrimaryAxis(resolvedPosition, point, tooltipWidth, tooltipHeight)) {
        resolvedPosition = opposite(resolvedPosition)
        point = coordinates(resolvedPosition, triggerRect, tooltipWidth, tooltipHeight)
      }

      const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - VIEWPORT_MARGIN - tooltipWidth)
      const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - VIEWPORT_MARGIN - tooltipHeight)
      const next: TooltipPlacement = {
        top: Math.min(Math.max(point.top, VIEWPORT_MARGIN), maxTop),
        left: Math.min(Math.max(point.left, VIEWPORT_MARGIN), maxLeft),
        maxHeight,
        ...(placement.maxWidth !== undefined ? { maxWidth: placement.maxWidth } : {}),
        measured: true,
      }

      setPlacement((current) =>
        current.top === next.top &&
        current.left === next.left &&
        current.maxHeight === next.maxHeight &&
        current.maxWidth === next.maxWidth &&
        current.measured
          ? current
          : next,
      )
    }

    updatePlacement()
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)
    return () => {
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
    }
  }, [content, placement.maxWidth, position, visible])

  const showTooltip = () => {
    if (!enabled) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setPlacement({
        top: VIEWPORT_MARGIN,
        left: VIEWPORT_MARGIN,
        maxHeight: viewportMaxHeight(),
        measured: false,
      })
      setVisible(true)
    }, delay)
  }

  const hideTooltip = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setVisible(false)
  }

  return (
    <>
      <span
        ref={triggerRef}
        className={triggerClassName}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
      >
        {children}
      </span>
      {visible &&
        createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            className={`fixed z-[9999] px-4 py-3 text-sm text-text-primary bg-bg-secondary border border-border rounded-lg shadow-xl break-words pointer-events-none ${className}`}
            style={{
              top: placement.top,
              left: placement.left,
              maxHeight: placement.maxHeight,
              ...(placement.maxWidth !== undefined ? { maxWidth: placement.maxWidth } : {}),
              overflowY: 'auto',
              visibility: placement.measured ? 'visible' : 'hidden',
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  )
}
