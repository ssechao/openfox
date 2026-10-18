// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Tooltip } from './Tooltip'

function rect(top: number, left: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect
}

function mockLayout(triggerRect: DOMRect, tooltipRect: DOMRect, width: number, height: number) {
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('innerHeight', height)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('role') === 'tooltip' ? tooltipRect : triggerRect
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Tooltip', () => {
  it('renders children in the trigger span with the default inline-flex class', () => {
    const { container } = render(<Tooltip content="tip content">hover me</Tooltip>)

    const trigger = container.firstElementChild as HTMLElement
    expect(trigger?.className).toContain('inline-flex')
    expect(container.textContent).toContain('hover me')
  })

  it('applies triggerClassName to the trigger span', () => {
    const { container } = render(
      <Tooltip content="tip content" triggerClassName="flex-1 min-w-0">
        hover me
      </Tooltip>,
    )

    const trigger = container.firstElementChild as HTMLElement
    expect(trigger?.className).toBe('flex-1 min-w-0')
  })

  it('shows the content on hover and hides it on mouse leave', async () => {
    const { container } = render(<Tooltip content="full tip text">hover me</Tooltip>)

    const trigger = container.firstElementChild as HTMLElement
    fireEvent.mouseEnter(trigger)
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('full tip text'))

    fireEvent.mouseLeave(trigger)
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  })

  it('does not show the content on hover when disabled', async () => {
    const { container } = render(
      <Tooltip content="full tip text" enabled={false}>
        hover me
      </Tooltip>,
    )

    const trigger = container.firstElementChild as HTMLElement
    fireEvent.mouseEnter(trigger)
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('flips a top tooltip below a trigger at the viewport edge', async () => {
    mockLayout(rect(2, 120, 40, 20), rect(0, 0, 100, 60), 300, 200)
    const { container } = render(
      <Tooltip content="tip content" position="top" delay={0}>
        hover me
      </Tooltip>,
    )

    fireEvent.mouseEnter(container.firstElementChild as HTMLElement)

    const tooltip = await screen.findByRole('tooltip')
    await waitFor(() => expect(tooltip.style.top).toBe('30px'))
    expect(tooltip.style.left).toBe('90px')
  })

  it.each([
    ['left', rect(80, 270, 28, 20), '142px', '65px'],
    ['right', rect(80, 10, 20, 20), '38px', '65px'],
  ] as const)('uses the correct trigger edge for %s placement', async (position, triggerRect, left, top) => {
    mockLayout(triggerRect, rect(0, 0, 120, 50), 320, 200)
    const { container } = render(
      <Tooltip content="tip content" position={position} delay={0}>
        hover me
      </Tooltip>,
    )

    fireEvent.mouseEnter(container.firstElementChild as HTMLElement)

    const tooltip = await screen.findByRole('tooltip')
    await waitFor(() => expect(tooltip.style.left).toBe(left))
    expect(tooltip.style.top).toBe(top)
  })

  it('limits tall content and keeps it inside the viewport', async () => {
    mockLayout(rect(70, 120, 40, 20), rect(0, 0, 100, 500), 300, 200)
    const { container } = render(
      <Tooltip content="very long content" position="right" delay={0}>
        hover me
      </Tooltip>,
    )

    fireEvent.mouseEnter(container.firstElementChild as HTMLElement)

    const tooltip = await screen.findByRole('tooltip')
    await waitFor(() => expect(tooltip.style.maxHeight).toBe('184px'))
    expect(tooltip.style.top).toBe('8px')
    expect(tooltip.style.overflowY).toBe('auto')
  })
})
