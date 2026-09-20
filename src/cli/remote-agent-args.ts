import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { VERSION } from '../constants.js'

// bun --define OPENFOX_RA_VERSION='"x"' replaces this identifier at compile time.
declare const OPENFOX_RA_VERSION: string

const DAEMON_OPTIONS = `Options:
  --workdir <dir>        Working directory for tool execution (required)
  --hub-url <url>        Aether hub URL (required)
  --hub-token <token>    Hub bearer token (required)
  --name <name>          Agent display name
  --identity-key <path>  Identity key file (default: ~/.config/openfox/remote-agent/<name>.key)
                         Also honoured via OPENFOX_RA_IDENTITY_KEY.
  --rotate-identity      Replace the persisted identity key with a fresh one
  --mcp-config <file>    JSON file with mcpServers to run on the daemon
  -h, --help             Show this help
  -v, --version          Show version

The daemon enrolls with the hub, polls for signed execution envelopes
(enroll/poll/result unchanged), and exposes GET /healthz on 127.0.0.1
(ephemeral port) for operators.`

export const REMOTE_AGENT_HELP = `remote-agent - OpenFox headless-agent daemon (no LLM, no UI, no session server)

Usage:
  remote-agent --workdir <dir> --hub-url <url> --hub-token <token> [options]
  remote-agent --help
  remote-agent --version

${DAEMON_OPTIONS}

add / remove / --print-config / --control-token are not available on this
binary. Use the full CLI on the OpenFox server:
  openfox remote-agent add --hub-url <url> --hub-token <token> [--control-token <t>]
  openfox remote-agent remove
  openfox remote-agent --print-config
`

export const OPENFOX_REMOTE_AGENT_HELP = `openfox remote-agent - headless-agent daemon or local hub config

Usage:
  openfox remote-agent --workdir <dir> --hub-url <url> --hub-token <token> [options]
  openfox remote-agent add --hub-url <url> --hub-token <token> [--control-token <token>]
  openfox remote-agent remove
  openfox remote-agent --print-config
  openfox remote-agent --help
  openfox remote-agent --version

${DAEMON_OPTIONS}

Local OpenFox server (not the slim remote-agent binary):
  add                    Write remoteAgent hub config to the global config
  remove                 Remove remoteAgent hub config
  --control-token <t>    Control-plane credential for add
  --print-config         Print a paste-ready OpenFox remoteAgent config snippet

On a remote box, install the standalone binary (no Node, no 6–8 GiB heap):
  curl -fsSL https://raw.githubusercontent.com/ssechao/openfox/main/scripts/install-remote-agent.sh | sh
`

export type RemoteAgentHelpKind = 'bin' | 'cli'

export type ParsedRemoteAgentArgs = {
  help: boolean
  version: boolean
  printConfig: boolean
  workdir?: string | undefined
  hubUrl?: string | undefined
  hubToken?: string | undefined
  controlToken?: string | undefined
  name?: string | undefined
  identityKey?: string | undefined
  rotateIdentity?: boolean | undefined
  mcpConfig?: string | undefined
  port?: number | undefined
  subcommand?: 'add' | 'remove' | undefined
  error?: string | undefined
}

const OPTIONS = {
  workdir: { type: 'string' },
  'hub-url': { type: 'string' },
  'hub-token': { type: 'string' },
  'control-token': { type: 'string' },
  name: { type: 'string' },
  'identity-key': { type: 'string' },
  'rotate-identity': { type: 'boolean' },
  'mcp-config': { type: 'string' },
  'print-config': { type: 'boolean' },
  port: { type: 'string', short: 'p' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const

export function parseRemoteAgentArgs(argv: string[]): ParsedRemoteAgentArgs {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    })
    const parsed: ParsedRemoteAgentArgs = {
      help: values.help === true || positionals.includes('help'),
      version: values.version === true,
      printConfig: values['print-config'] === true,
    }
    if (values.workdir) parsed.workdir = values.workdir
    if (values['hub-url']) parsed.hubUrl = values['hub-url']
    if (values['hub-token']) parsed.hubToken = values['hub-token']
    if (values['control-token']) parsed.controlToken = values['control-token']
    if (values.name) parsed.name = values.name
    // Explicit key path: flag wins, else the env var.
    const identityKey = values['identity-key'] ?? process.env['OPENFOX_RA_IDENTITY_KEY']
    if (identityKey) parsed.identityKey = identityKey
    if (values['rotate-identity'] === true) parsed.rotateIdentity = true
    if (values['mcp-config']) parsed.mcpConfig = values['mcp-config']
    if (values.port) {
      const port = Number.parseInt(values.port, 10)
      if (Number.isFinite(port)) parsed.port = port
    }
    const sub = positionals.find((p) => p === 'add' || p === 'remove')
    if (sub === 'add' || sub === 'remove') parsed.subcommand = sub
    return parsed
  } catch (error) {
    return {
      help: argv.includes('--help') || argv.includes('-h'),
      version: argv.includes('--version') || argv.includes('-v'),
      printConfig: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function injectedRelease(): string | undefined {
  try {
    return OPENFOX_RA_VERSION
  } catch {
    return undefined
  }
}

export function getRemoteAgentVersion(): string {
  const injected = injectedRelease()
  if (injected) return injected
  const embedded = process.env['VERSION']
  if (embedded && embedded !== 'unknown') return embedded
  if (VERSION && VERSION !== 'unknown') return VERSION
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    if (pkg.version) return pkg.version
  } catch {
    // compiled binary without package.json next to sources
  }
  return VERSION
}

export function printRemoteAgentHelp(kind: RemoteAgentHelpKind = 'bin'): void {
  console.log(kind === 'cli' ? OPENFOX_REMOTE_AGENT_HELP : REMOTE_AGENT_HELP)
}

export function printRemoteAgentVersion(): void {
  console.log(getRemoteAgentVersion())
}
