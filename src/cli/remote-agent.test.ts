import { afterEach, describe, expect, it, vi } from 'vitest'
import { printConfigSnippet } from './remote-agent.js'

/**
 * The `--print-config` snippet is advertised as paste-ready, so the printed
 * `remoteAgent` block MUST be valid JSON in every branch (with or without a
 * control token). Regression guard for the missing-comma / unterminated-string
 * bug.
 */
describe('printConfigSnippet', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function capture(options: Parameters<typeof printConfigSnippet>[0]): string {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printConfigSnippet(options)
    expect(log).toHaveBeenCalledTimes(1)
    return log.mock.calls[0]![0] as string
  }

  function extractJsonBlock(output: string): string {
    const start = output.indexOf('{')
    const end = output.lastIndexOf('}')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    return output.slice(start, end + 1)
  }

  it('emits valid JSON with an explicit control token', () => {
    const output = capture({
      hubUrl: 'http://hub.example:4175/mcp',
      hubToken: 'hub-token',
      controlToken: 'control-token',
    })
    const parsed = JSON.parse(extractJsonBlock(output))
    expect(parsed).toEqual({
      remoteAgent: {
        hubUrl: 'http://hub.example:4175/mcp',
        hubToken: 'hub-token',
        controlToken: 'control-token',
      },
    })
  })

  it('emits valid JSON without a control token (placeholder form)', () => {
    const output = capture({ hubUrl: 'http://hub.example:4175/mcp', hubToken: 'hub-token' })
    const parsed = JSON.parse(extractJsonBlock(output))
    expect(parsed).toEqual({
      remoteAgent: {
        hubUrl: 'http://hub.example:4175/mcp',
        hubToken: 'hub-token',
        controlToken: '<ra-control-token>',
      },
    })
    // The optional-note must live outside the JSON, never inside a string value.
    expect(output).toMatch(/controlToken.*optional/i)
  })

  it('emits valid JSON when hub url/token are omitted (placeholders)', () => {
    const output = capture({})
    const parsed = JSON.parse(extractJsonBlock(output))
    expect(parsed.remoteAgent.hubUrl).toBe('<hub-url>')
    expect(parsed.remoteAgent.hubToken).toBe('<hub-token>')
  })
})
