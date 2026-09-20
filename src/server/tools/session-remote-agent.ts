import { createTool } from './tool-helpers.js'
import { serverT } from '../i18n.js'

interface SessionRemoteAgentArgs {
  action?: string
  target?: string
}

/**
 * Let the agent pin (or unpin) its own session — or the project default — to a
 * remote headless-agent, on the user's request. Once pinned, the session's
 * environment tools (run_command, read_file, ...) execute on that machine
 * WITHOUT the model having to pass `remote` on every call. An explicit
 * `remote` argument on a tool call still overrides the pin.
 *
 * This is a control-plane tool: it always runs locally (never routed) and
 * requires a configured remote-agent hub.
 */
export const sessionRemoteAgentTool = createTool<SessionRemoteAgentArgs>(
  'session_remote_agent',
  {
    type: 'function',
    function: {
      name: 'session_remote_agent',
      description:
        'Pin or unpin THIS session (or its project default) to a remote headless-agent, so environment tools ' +
        '(run_command, read_file, write_file, edit_file, dev_server, background_process, web_fetch, web_search) execute ' +
        'on that machine WITHOUT passing `remote` on every call. Use it when the user asks to lock/attach the session to a ' +
        'remote machine, or to stop using one. Actions: "set" (pin this session to `target`), "local" (force local execution ' +
        'for this session), "clear" (remove the session pin, inheriting the project default), "project" (set/clear the ' +
        'project-wide default, `target` omitted = clear), "status" (show the current pin and effective target). ' +
        'A per-call `remote` argument always overrides the pin. Discover agents with the remote_agents tool.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['set', 'local', 'clear', 'project', 'status'],
            description: 'The operation to perform.',
          },
          target: {
            type: 'string',
            description:
              'The headless-agent id or title (for "set"), or the project default target (for "project"). Omit to clear the project default.',
          },
        },
        required: ['action'],
      },
    },
  },
  async (args, context, helpers) => {
    const action = typeof args.action === 'string' ? args.action : ''
    const target = typeof args.target === 'string' ? args.target.trim() : undefined

    const { getSessionRemoteAgentTarget, updateSessionRemoteAgentTarget } = await import('../db/sessions.js')
    const { getProject, updateProject } = await import('../db/projects.js')
    const { resolveRemoteAgentTarget } = await import('../remote-agent/session-target.js')

    const sessionId = context.sessionId
    const projectId = context.sessionManager.getSession(sessionId)?.projectId

    const describe = () => {
      const sessionPin = getSessionRemoteAgentTarget(sessionId)
      const projectTarget = projectId ? (getProject(projectId)?.remoteAgentTarget ?? null) : null
      const effective = projectId ? resolveRemoteAgentTarget(projectId, sessionId) : null
      return { sessionPin, projectTarget, effective }
    }

    switch (action) {
      case 'set': {
        if (!target) {
          return helpers.error(
            serverT({
              en: 'action "set" requires a non-empty `target` (agent id or title).',
              fr: 'L’action « set » requiert un `target` non vide (id ou titre de l’agent).',
            }),
          )
        }
        updateSessionRemoteAgentTarget(sessionId, target)
        return helpers.success(
          serverT(
            {
              en: 'Session pinned to remote-agent "{{target}}". Environment tools without an explicit `remote` now run there.',
              fr: 'Session épinglée sur l’agent distant « {{target}} ». Les outils d’environnement sans `remote` explicite s’y exécutent désormais.',
            },
            { target },
          ),
        )
      }
      case 'local': {
        updateSessionRemoteAgentTarget(sessionId, '')
        return helpers.success(
          serverT({
            en: 'Session forced to local execution. Environment tools now run on this machine (an explicit `remote` still overrides).',
            fr: 'Session forcée en exécution locale. Les outils d’environnement s’exécutent maintenant sur cette machine (un `remote` explicite reste prioritaire).',
          }),
        )
      }
      case 'clear': {
        updateSessionRemoteAgentTarget(sessionId, null)
        const { effective } = describe()
        return helpers.success(
          effective
            ? serverT(
                {
                  en: 'Session remote-agent pin cleared. Now inheriting the project default: "{{target}}".',
                  fr: 'Pin remote-agent de session effacé. Hérite désormais du défaut projet : « {{target}} ».',
                },
                { target: effective },
              )
            : serverT({
                en: 'Session remote-agent pin cleared. No project default; environment tools run locally.',
                fr: 'Pin remote-agent de session effacé. Aucun défaut projet ; les outils d’environnement s’exécutent localement.',
              }),
        )
      }
      case 'project': {
        if (!projectId) {
          return helpers.error(
            serverT({
              en: 'Cannot resolve the project for this session.',
              fr: 'Impossible de résoudre le projet de cette session.',
            }),
          )
        }
        const value = target && target.length > 0 ? target : null
        updateProject(projectId, { remoteAgentTarget: value })
        return helpers.success(
          value
            ? serverT(
                {
                  en: 'Project default remote-agent set to "{{target}}" (inherited by its sessions).',
                  fr: 'Défaut projet remote-agent défini sur « {{target}} » (hérité par ses sessions).',
                },
                { target: value },
              )
            : serverT({
                en: 'Project default remote-agent cleared.',
                fr: 'Défaut projet remote-agent effacé.',
              }),
        )
      }
      case 'status': {
        const state = describe()
        return helpers.success(
          JSON.stringify(
            { sessionPin: state.sessionPin, projectDefault: state.projectTarget, effective: state.effective },
            null,
            2,
          ),
        )
      }
      default:
        return helpers.error(
          serverT({
            en: 'Unknown action. Use one of: set, local, clear, project, status.',
            fr: 'Action inconnue. Utilisez : set, local, clear, project, status.',
          }),
        )
    }
  },
)
