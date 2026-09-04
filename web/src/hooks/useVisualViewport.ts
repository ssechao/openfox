import { useState, useEffect, useRef } from 'react'

export interface VisualViewportState {
  offsetTop: number
  height: number
  keyboardVisible: boolean
}

export function useVisualViewport() {
  const [state, setState] = useState<VisualViewportState>({
    offsetTop: 0,
    height: window.innerHeight,
    keyboardVisible: false,
  })
  const baseHeightRef = useRef(window.innerHeight)
  const lastStateRef = useRef(state)

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    const update = () => {
      const offsetTop = vv.offsetTop
      const height = vv.height
      const keyboardVisible = baseHeightRef.current - height > 100
      // visualViewport fires resize/scroll on every frame of a window drag,
      // but the values often don't change (a horizontal resize keeps
      // offsetTop/height constant). Only re-render when something actually
      // changed, so a drag doesn't re-render the whole tree every frame.
      const prev = lastStateRef.current
      if (prev.offsetTop === offsetTop && prev.height === height && prev.keyboardVisible === keyboardVisible) {
        return
      }
      const next = { offsetTop, height, keyboardVisible }
      lastStateRef.current = next
      setState(next)
    }

    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)

    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  return state
}
