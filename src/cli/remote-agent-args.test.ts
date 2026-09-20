import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OPENFOX_REMOTE_AGENT_HELP,
  REMOTE_AGENT_HELP,
  getRemoteAgentVersion,
  parseRemoteAgentArgs,
  printRemoteAgentHelp,
  printRemoteAgentVersion,
} from './remote-agent-args.js'

const here = dirname(fileURLToPath(import.meta.url))

describe('parseRemoteAgentArgs', () => {
  it('parses daemon flags', () => {
    const parsed = parseRemoteAgentArgs([
      '--workdir',
      '/tmp/work',
      '--hub-url',
      'http://hub.example/mcp',
      '--hub-token',
      'secret',
      '--name',
      'build-box',
      '--mcp-config',
      '/tmp/mcp.json',
    ])
    expect(parsed.error).toBeUndefined()
    expect(parsed.help).toBe(false)
    expect(parsed.workdir).toBe('/tmp/work')
    expect(parsed.hubUrl).toBe('http://hub.example/mcp')
    expect(parsed.hubToken).toBe('secret')
    expect(parsed.name).toBe('build-box')
    expect(parsed.mcpConfig).toBe('/tmp/mcp.json')
  })

  it('treats --help and -h as help', () => {
    expect(parseRemoteAgentArgs(['--help']).help).toBe(true)
    expect(parseRemoteAgentArgs(['-h']).help).toBe(true)
    expect(parseRemoteAgentArgs(['help']).help).toBe(true)
  })

  it('treats --version and -v as version', () => {
    expect(parseRemoteAgentArgs(['--version']).version).toBe(true)
    expect(parseRemoteAgentArgs(['-v']).version).toBe(true)
  })

  it('parses add/remove subcommands', () => {
    expect(parseRemoteAgentArgs(['add', '--hub-url', 'http://h', '--hub-token', 't']).subcommand).toBe('add')
    expect(parseRemoteAgentArgs(['remove']).subcommand).toBe('remove')
  })

  it('returns an error for unknown flags without throwing', () => {
    const parsed = parseRemoteAgentArgs(['--not-a-real-flag'])
    expect(parsed.error).toMatch(/not-a-real-flag|unknown/i)
  })
})

describe('remote-agent help/version text', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('documents daemon flags and healthz', () => {
    for (const needle of ['--workdir', '--hub-url', '--hub-token', '--name', '--mcp-config', 'healthz']) {
      expect(REMOTE_AGENT_HELP).toContain(needle)
      expect(OPENFOX_REMOTE_AGENT_HELP).toContain(needle)
    }
  })

  it('prints standalone usage for the slim binary', () => {
    expect(REMOTE_AGENT_HELP).toMatch(/Usage:\n {2}remote-agent --workdir/)
    expect(REMOTE_AGENT_HELP).not.toMatch(/Usage:\n {2}openfox remote-agent --workdir/)
  })

  it('prints openfox remote-agent usage plus add/remove/--control-token on the full CLI', () => {
    expect(OPENFOX_REMOTE_AGENT_HELP).toMatch(/Usage:\n {2}openfox remote-agent --workdir/)
    expect(OPENFOX_REMOTE_AGENT_HELP).toContain('openfox remote-agent add')
    expect(OPENFOX_REMOTE_AGENT_HELP).toContain('openfox remote-agent remove')
    expect(OPENFOX_REMOTE_AGENT_HELP).toContain('--control-token')
    expect(OPENFOX_REMOTE_AGENT_HELP).toContain('--print-config')
    expect(OPENFOX_REMOTE_AGENT_HELP).not.toMatch(/Usage:\n {2}remote-agent --workdir/)
  })

  it('prints help and version to stdout', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printRemoteAgentHelp()
    printRemoteAgentHelp('cli')
    printRemoteAgentVersion()
    const text = log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(text).toContain('--workdir')
    expect(text).toContain('openfox remote-agent add')
    expect(text).toContain(getRemoteAgentVersion())
  })

  it('does not import sqlite, i18n, or the session server', () => {
    const src = readFileSync(join(here, 'remote-agent-args.ts'), 'utf8')
    expect(src).not.toMatch(/i18n|better-sqlite3|sessions\.db|serve\.js|max-old-space/)
  })

  it('parses --identity-key and --rotate-identity', () => {
    const parsed = parseRemoteAgentArgs([
      '--workdir',
      '/w',
      '--hub-url',
      'http://h/mcp',
      '--hub-token',
      't',
      '--identity-key',
      '/keys/my.key',
      '--rotate-identity',
    ])
    expect(parsed.error).toBeUndefined()
    expect(parsed.identityKey).toBe('/keys/my.key')
    expect(parsed.rotateIdentity).toBe(true)
  })

  it('falls back to OPENFOX_RA_IDENTITY_KEY, with the flag taking precedence', () => {
    const previous = process.env['OPENFOX_RA_IDENTITY_KEY']
    process.env['OPENFOX_RA_IDENTITY_KEY'] = '/env/key'
    try {
      expect(parseRemoteAgentArgs([]).identityKey).toBe('/env/key')
      expect(parseRemoteAgentArgs(['--identity-key', '/flag/key']).identityKey).toBe('/flag/key')
    } finally {
      if (previous === undefined) delete process.env['OPENFOX_RA_IDENTITY_KEY']
      else process.env['OPENFOX_RA_IDENTITY_KEY'] = previous
    }
  })

  it('leaves identity options undefined when not provided', () => {
    const parsed = parseRemoteAgentArgs([])
    expect(parsed.identityKey).toBeUndefined()
    expect(parsed.rotateIdentity).toBeUndefined()
  })
})
