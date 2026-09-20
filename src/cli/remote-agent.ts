import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { cliT } from './i18n.js'
import type { Mode } from './main.js'

export interface RemoteAgentCommandOptions {
  workdir?: string | undefined
  hubUrl?: string | undefined
  hubToken?: string | undefined
  /** Control-plane credential for the hub's control routes (config `add`). */
  controlToken?: string | undefined
  name?: string | undefined
  mcpConfig?: string | undefined
  printConfig?: boolean
  port?: number | undefined
}

/**
 * `openfox remote-agent` — run a headless-agent daemon (remote machine tool
 * executor) or manage the local server's remote-agent hub config.
 *
 * Daemon mode (default): `openfox remote-agent --workdir <dir> --hub-url <url> --hub-token <t>`
 *   - no LLM, no UI, no session server
 *   - enrolls with the hub, polls for signed execution envelopes, executes
 *     built-in tools anchored on --workdir, posts results back to the hub.
 *
 * Config mode:
 *   - `openfox remote-agent add --hub-url <url> --hub-token <t>`: enable remote
 *     execution on this OpenFox server (writes remoteAgent to global config).
 *   - `openfox remote-agent remove`: disable it.
 *   - `--print-config`: print the paste-ready config snippet.
 */
export async function runRemoteAgentCommand(
  mode: Mode,
  options: RemoteAgentCommandOptions,
  subcommand?: 'add' | 'remove',
): Promise<void> {
  // argv: [node, script, 'remote-agent', <sub>?] — add/remove is the first
  // positional after 'remote-agent'. The slim binary rejects those subcommands.
  const positional = process.argv.slice(3)[0]
  const sub = subcommand ?? (positional === 'add' || positional === 'remove' ? positional : undefined)

  if (sub === 'add' || sub === 'remove') {
    await runConfigSubcommand(mode, sub, options)
    return
  }

  if (options.printConfig) {
    printConfigSnippet(options)
    return
  }

  // Daemon mode.
  if (!options.workdir) {
    console.error(
      cliT({
        en: 'Error: --workdir is required for remote-agent daemon mode',
        fr: 'Erreur : --workdir est requis pour le mode daemon remote-agent',
      }),
    )
    process.exit(1)
  }
  if (!options.hubUrl) {
    console.error(
      cliT({
        en: 'Error: --hub-url is required for remote-agent daemon mode',
        fr: 'Erreur : --hub-url est requis pour le mode daemon remote-agent',
      }),
    )
    process.exit(1)
  }
  if (!options.hubToken) {
    console.error(
      cliT({
        en: 'Error: --hub-token is required for remote-agent daemon mode',
        fr: 'Erreur : --hub-token est requis pour le mode daemon remote-agent',
      }),
    )
    process.exit(1)
  }
  if (!existsSync(options.workdir)) {
    console.error(
      cliT(
        { en: 'Error: workdir does not exist: {{dir}}', fr: 'Erreur : le workdir n’existe pas : {{dir}}' },
        { dir: options.workdir },
      ),
    )
    process.exit(1)
  }

  let mcpServers: Record<string, unknown> | undefined
  if (options.mcpConfig) {
    try {
      const raw = await readFile(options.mcpConfig, 'utf-8')
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> }
      mcpServers = parsed.mcpServers
    } catch (error) {
      console.error(
        cliT(
          {
            en: 'Error: failed to read --mcp-config {{file}}: {{error}}',
            fr: 'Erreur : échec de lecture de --mcp-config {{file}} : {{error}}',
          },
          { file: options.mcpConfig, error: String(error) },
        ),
      )
      process.exit(1)
    }
  }

  const { RemoteAgentDaemon } = await import('../server/remote-agent/daemon.js')
  const daemon = new RemoteAgentDaemon({
    workdir: options.workdir,
    hubUrl: options.hubUrl,
    hubToken: options.hubToken,
    name: options.name,
    mcpServers,
  })

  const shutdown = async () => {
    await daemon.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  console.log(
    cliT({
      en: 'Starting remote-agent daemon (headless, no LLM)…',
      fr: 'Démarrage du daemon remote-agent (headless, sans LLM)…',
    }),
  )
  try {
    await daemon.start()
  } catch (error) {
    console.error(
      cliT(
        {
          en: 'Failed to start remote-agent daemon: {{error}}',
          fr: 'Échec du démarrage du daemon remote-agent : {{error}}',
        },
        { error: String(error) },
      ),
    )
    process.exit(1)
  }
}

async function runConfigSubcommand(
  mode: Mode,
  sub: 'add' | 'remove',
  options: RemoteAgentCommandOptions,
): Promise<void> {
  const { loadGlobalConfig, saveGlobalConfig } = await import('./config.js')
  const globalConfig = await loadGlobalConfig(mode)

  if (sub === 'remove') {
    const updated = { ...globalConfig }
    delete updated.remoteAgent
    await saveGlobalConfig(mode, updated)
    console.log(
      cliT({ en: 'Remote-agent hub removed from config.', fr: 'Hub remote-agent retiré de la configuration.' }),
    )
    return
  }

  if (!options.hubUrl || !options.hubToken) {
    console.error(
      cliT({
        en: 'Error: add requires --hub-url and --hub-token',
        fr: 'Erreur : add nécessite --hub-url et --hub-token',
      }),
    )
    process.exit(1)
  }
  await saveGlobalConfig(mode, {
    ...globalConfig,
    remoteAgent: {
      hubUrl: options.hubUrl,
      hubToken: options.hubToken,
      ...(options.controlToken ? { controlToken: options.controlToken } : {}),
    },
  })
  console.log(
    cliT({
      en: 'Remote-agent hub configured. Restart the OpenFox server to enable remote execution.',
      fr: 'Hub remote-agent configuré. Redémarrez le serveur OpenFox pour activer l’exécution à distance.',
    }),
  )
}

export function printConfigSnippet(options: RemoteAgentCommandOptions): void {
  const hubUrl = options.hubUrl ?? '<hub-url>'
  const hubToken = options.hubToken ?? '<hub-token>'
  // Leading comma: `controlToken` follows `hubToken`, so the JSON stays valid.
  const controlTokenLine = options.controlToken
    ? `,\n    "controlToken": "${options.controlToken}"`
    : `,\n    "controlToken": "<ra-control-token>"`
  const controlTokenNote = options.controlToken
    ? ''
    : cliT({
        en: '\nNote: "controlToken" is optional — set it to the hub’s AETHER_RA_CONTROL_TOKEN when the hub enforces a control credential.',
        fr: '\nNote : "controlToken" est optionnel — mettez la valeur de AETHER_RA_CONTROL_TOKEN du hub quand celui-ci impose un credential de contrôle.',
      })
  console.log(
    cliT({
      en: `Add this to your OpenFox global config (or run: openfox remote-agent add --hub-url ${hubUrl} --hub-token ${hubToken}${options.controlToken ? ` --control-token ${options.controlToken}` : ''}):

{
  "remoteAgent": {
    "hubUrl": "${hubUrl}",
    "hubToken": "${hubToken}"${controlTokenLine}
  }
}
${controlTokenNote}
`,
      fr: `Ajoutez ceci à votre config globale OpenFox (ou exécutez : openfox remote-agent add --hub-url ${hubUrl} --hub-token ${hubToken}${options.controlToken ? ` --control-token ${options.controlToken}` : ''}) :

{
  "remoteAgent": {
    "hubUrl": "${hubUrl}",
    "hubToken": "${hubToken}"${controlTokenLine}
  }
}
${controlTokenNote}
`,
    }),
  )
}
