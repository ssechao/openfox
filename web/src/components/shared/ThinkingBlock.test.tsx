// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { ThinkingBlock } from './ThinkingBlock'
import { getMarkdownCacheSizeForTest, resetMarkdownCacheForTest } from './Markdown'
import { renderToString } from 'react-dom/server'

describe('ThinkingBlock', () => {
  describe('default variant', () => {
    it('parses markdown content', () => {
      const content = 'This is **bold** and this is `code`'
      const html = renderToString(<ThinkingBlock content={content} />)

      expect(html).toContain('bold</strong>')
      expect(html).toContain('code</code>')
    })

    it('renders list items as proper HTML', () => {
      const content = '- Item one\n- Item two'
      const html = renderToString(<ThinkingBlock content={content} />)

      expect(html).toContain('<ul')
      expect(html).toContain('<li')
    })

    it('renders headers', () => {
      const content = '## Header'
      const html = renderToString(<ThinkingBlock content={content} />)

      expect(html).toContain('<h2')
      expect(html).toContain('Header')
    })
  })

  describe('labeled variant', () => {
    it('parses markdown content', () => {
      const content = 'This is **bold** and this is `code`'
      const html = renderToString(<ThinkingBlock content={content} variant="labeled" />)

      expect(html).toContain('bold</strong>')
      expect(html).toContain('code</code>')
    })

    it('shows thinking label', () => {
      const content = 'Some thought'
      const html = renderToString(<ThinkingBlock content={content} variant="labeled" />)

      expect(html).toContain('thinking:')
    })
  })

  // Finding D (remediation plan): a thinking stream is not immutable content.
  // Caching each growing prefix turns one long reasoning message into hundreds
  // of retained render trees.
  describe('streaming thinking content', () => {
    // Markdown syntax on purpose: the plain-text fast path never reaches the
    // cache, so plain prose would prove nothing.
    const prefix = (deltas: number): string =>
      Array.from({ length: deltas }, (_, i) => `- **Step ${i}**: borrow \`&self\` then \`&mut\``).join('\n')

    it('does not cache intermediate prefixes while the thinking stream grows', () => {
      resetMarkdownCacheForTest()

      for (let i = 1; i <= 200; i++) {
        renderToString(<ThinkingBlock content={prefix(i)} isStreaming />)
      }

      expect(getMarkdownCacheSizeForTest()).toBe(0)
    })

    it('caches the completed thinking content once and reuses it', () => {
      resetMarkdownCacheForTest()
      const final = prefix(200)

      renderToString(<ThinkingBlock content={final} isStreaming />)
      const html = renderToString(<ThinkingBlock content={final} />)
      expect(html).toContain('Step 199')
      expect(getMarkdownCacheSizeForTest()).toBe(1)

      renderToString(<ThinkingBlock content={final} />)
      expect(getMarkdownCacheSizeForTest()).toBe(1)
    })

    it('keeps caching completed thinking in the labeled variant', () => {
      resetMarkdownCacheForTest()

      renderToString(<ThinkingBlock content={prefix(3)} variant="labeled" isStreaming />)
      expect(getMarkdownCacheSizeForTest()).toBe(0)

      renderToString(<ThinkingBlock content={prefix(3)} variant="labeled" />)
      expect(getMarkdownCacheSizeForTest()).toBe(1)
    })
  })
})
