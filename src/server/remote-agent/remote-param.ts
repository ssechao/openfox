import type { Tool } from '../tools/types.js'

/**
 * Environment tools that gain an optional `remote` argument. When present and
 * non-empty, the call is routed to that headless-agent (remote-agent) via the
 * hub instead of executing locally. Control-plane tools (ask_user,
 * session_metadata, mcp_config, call_sub_agent, workspace, project_tasks,
 * step_done, remote_agents) never take `remote` — they always run locally.
 */
export const REMOTE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'describe_image',
  'write_file',
  'edit_file',
  'run_command',
  'load_skill',
  'web_fetch',
  'web_search',
  'dev_server',
  'background_process',
])

const REMOTE_PARAM_DESCRIPTION =
  'Optional. Target headless-agent (remote-agent) id or title on which to execute this tool instead of locally. ' +
  'Omit to execute locally. List available agents with the remote_agents tool. ' +
  'The tool runs on the remote machine (its workdir), not on this machine.'

/**
 * Return a copy of `tool` whose definition includes the optional `remote`
 * argument (for environment tools). Non-environment tools are returned
 * unchanged. The tool's execute is untouched — routing happens in the
 * dispatcher, not here.
 */
export function withRemoteParam(tool: Tool): Tool {
  if (!REMOTE_TOOL_NAMES.has(tool.name)) return tool
  const params = tool.definition.function.parameters as Record<string, unknown>
  const properties = (params['properties'] ?? {}) as Record<string, unknown>
  if (properties['remote']) return tool
  return {
    ...tool,
    definition: {
      ...tool.definition,
      function: {
        ...tool.definition.function,
        parameters: {
          ...params,
          properties: {
            ...properties,
            remote: {
              type: 'string',
              description: REMOTE_PARAM_DESCRIPTION,
            },
          },
        },
      },
    },
  }
}
