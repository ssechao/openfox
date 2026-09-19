import './remote-agent-polyfill.js'
import {
  parseRemoteAgentArgs,
  printRemoteAgentHelp,
  printRemoteAgentVersion,
  type ParsedRemoteAgentArgs,
} from './remote-agent-args.js'
import type { RemoteAgentCommandOptions } from './remote-agent.js'

export function toRemoteAgentOptions(parsed: ParsedRemoteAgentArgs): RemoteAgentCommandOptions {
  const options: RemoteAgentCommandOptions = {}
  if (parsed.workdir) options.workdir = parsed.workdir
  if (parsed.hubUrl) options.hubUrl = parsed.hubUrl
  if (parsed.hubToken) options.hubToken = parsed.hubToken
  if (parsed.controlToken) options.controlToken = parsed.controlToken
  if (parsed.name) options.name = parsed.name
  if (parsed.mcpConfig) options.mcpConfig = parsed.mcpConfig
  if (parsed.port !== undefined) options.port = parsed.port
  if (parsed.printConfig) options.printConfig = true
  return options
}

export async function runRemoteAgentBin(argv: string[]): Promise<number> {
  const parsed = parseRemoteAgentArgs(argv)
  if (parsed.help) {
    printRemoteAgentHelp('bin')
    return 0
  }
  if (parsed.version) {
    printRemoteAgentVersion()
    return 0
  }
  if (parsed.error) {
    console.error(parsed.error)
    printRemoteAgentHelp('bin')
    return 1
  }
  if (parsed.subcommand === 'add' || parsed.subcommand === 'remove' || parsed.printConfig) {
    console.error(
      'Error: add, remove, and --print-config are only available on `openfox remote-agent` (full CLI), not this slim binary.',
    )
    printRemoteAgentHelp('bin')
    return 1
  }
  if (!parsed.workdir || !parsed.hubUrl || !parsed.hubToken) {
    console.error('Error: --workdir, --hub-url and --hub-token are required for remote-agent daemon mode')
    printRemoteAgentHelp('bin')
    return 1
  }
  const { runRemoteAgentCommand } = await import('./remote-agent.js')
  await runRemoteAgentCommand('production', toRemoteAgentOptions(parsed))
  return 0
}
