import type React from 'react'

export function dedupById<T extends { id: string }>(defaults: T[], overrides: T[]): T[] {
  const overrideIds = new Set(overrides.map((i) => i.id))
  return [...defaults.filter((i) => !overrideIds.has(i.id)), ...overrides]
}

function highlightSpan(key: number, current: string, isMatch: boolean): React.ReactNode {
  return isMatch ? (
    <span key={key} className="font-semibold text-accent-primary">
      {current}
    </span>
  ) : (
    current
  )
}

function renderHighlighted(text: string, matched: boolean[]): React.ReactNode {
  if (!matched.some(Boolean)) return text
  const chars = Array.from(text)
  const parts: React.ReactNode[] = []
  let current = ''
  let currentMatch = matched[0] ?? false
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] ?? ''
    if (matched[i] === currentMatch) {
      current += char
    } else {
      parts.push(highlightSpan(parts.length, current, currentMatch))
      current = char
      currentMatch = matched[i] ?? false
    }
  }
  parts.push(highlightSpan(parts.length, current, currentMatch))
  return <>{parts}</>
}

export function highlightExact(text: string, query: string): React.ReactNode {
  if (!query) return text
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  if (tokens.length === 0) return text
  const lower = text.toLowerCase()
  const matched = new Array(text.length).fill(false)
  for (const token of tokens) {
    let from = 0
    while (from < lower.length) {
      const idx = lower.indexOf(token, from)
      if (idx < 0) break
      for (let i = idx; i < idx + token.length; i++) matched[i] = true
      from = idx + token.length
    }
  }
  return renderHighlighted(text, matched)
}

export function highlightMatches(text: string, query: string): React.ReactNode {
  if (!query) return text
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()

  const matched = new Array(text.length).fill(false)

  const exactIdx = lowerText.indexOf(lowerQuery)
  if (exactIdx >= 0) {
    for (let i = exactIdx; i < exactIdx + lowerQuery.length; i++) {
      matched[i] = true
    }
  } else {
    let qi = 0
    for (let i = 0; i < text.length && qi < lowerQuery.length; i++) {
      if (lowerText[i] === lowerQuery[qi]) {
        matched[i] = true
        qi++
      }
    }
  }

  return renderHighlighted(text, matched)
}

export function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true
  const queryParts = query.toLowerCase().split(/\s+/)
  const words = text.toLowerCase().split(/\s+/)
  return queryParts.every((qp) => {
    for (const word of words) {
      let qi = 0
      for (let ni = 0; ni < word.length && qi < qp.length; ni++) {
        if (word[ni] === qp[qi]) qi++
      }
      if (qi === qp.length) return true
    }
    return false
  })
}

export function handleModalNavigation(
  e: React.KeyboardEvent,
  maxIndex: number,
  setSelectedIndex: (fn: (i: number) => number) => void,
  onEnter: () => void,
  onEscape: () => void,
) {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, maxIndex))
      break
    case 'ArrowUp':
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
      break
    case 'Enter':
      e.preventDefault()
      onEnter()
      break
    case 'Escape':
      e.preventDefault()
      onEscape()
      break
  }
}
