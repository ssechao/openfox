import { createTool } from './tool-helpers.js'
import { getHubClient, HubClientError } from '../remote-agent/client.js'
import { serverT } from '../i18n.js'

/**
 * List the headless-agents (remote-agents) registered on the aether hub. This
 * is how a session discovers which remote machines it can drive. A session may
 * drive several agents at once by passing `remote:<id-or-title>` to the
 * environment tools (run_command, read_file, ...).
 *
 * This is a control-plane tool: it always runs locally (it takes no `remote`
 * argument) and requires a configured remote-agent hub.
 */
export const remoteAgentsTool = createTool(
  'remote_agents',
  {
    type: 'function',
    function: {
      name: 'remote_agents',
      description:
        'List the headless-agents (remote machines) registered on the aether hub that you can drive. ' +
        'Each agent exposes the environment tools (run_command, read_file, write_file, edit_file, ...) which ' +
        'accept an optional `remote` argument (the agent id or title) to execute on that machine instead of locally. ' +
        'Call this first to discover available agents; a single session can drive several agents at once.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  async (_args, _context, helpers) => {
    const hub = getHubClient()
    if (!hub) {
      return helpers.error(
        serverT({
          en: 'No remote-agent hub is configured. Set remoteAgent.hubUrl and remoteAgent.hubToken in the global config to enable remote execution.',
          fr: 'Aucun hub remote-agent n’est configuré. Définissez remoteAgent.hubUrl et remoteAgent.hubToken dans la config globale pour activer l’exécution à distance.',
        }),
      )
    }
    try {
      const agents = await hub.listAgents()
      if (agents.length === 0) {
        return helpers.success(
          serverT({
            en: 'No headless-agents are currently registered on the hub.',
            fr: 'Aucun agent distant n’est actuellement enregistré sur le hub.',
          }),
        )
      }
      const lines = agents.map((a) => {
        const status = a.alive ? 'alive' : 'offline'
        return `- ${a.title} [${a.peerId}] — ${status}, workdir: ${a.workdir}, host: ${a.hostname}, tools: ${a.capabilities.join(', ') || 'n/a'}`
      })
      const header = serverT({
        en: 'Available headless-agents (remote machines). Use the `remote` argument of environment tools to execute on one:',
        fr: 'Agents distants disponibles (machines distantes). Utilisez l’argument `remote` des outils d’environnement pour exécuter sur l’un d’eux :',
      })
      return helpers.success(`${header}\n${lines.join('\n')}`)
    } catch (error) {
      if (error instanceof HubClientError) {
        return helpers.error(error.message)
      }
      return helpers.error(error instanceof Error ? error.message : 'Failed to list remote agents')
    }
  },
)
