import { createTool } from '../tool-helpers.js'
import { runBackgroundAction } from './backend.js'

export type { BackgroundProcessToolArgs } from './actions.js'
import type { BackgroundProcessToolArgs } from './actions.js'

export const backgroundProcessTool = createTool<BackgroundProcessToolArgs>(
  'background_process',
  {
    type: 'function',
    function: {
      name: 'background_process',
      description: `Start, stop, and monitor long-running background processes.

These processes run independently of agent turns and persist across session compaction. Processes are displayed in the right sidebar where you can view their logs and status.

**Actions:**
- start: Launch a new background process (provide: name, command, cwd, timeout, notifyOnExit)
- stop: Stop a running process and remove it from the sidebar
- list: Show all processes for this session
- status: Get detailed status of a specific process
- logs: Retrieve process output with optional pagination

For a long job whose result you need, set notifyOnExit: true and end your turn: when the process ends on its own or by its timeout, a message with its exit code and last output lines is queued to this session and starts a new turn. An explicit stop sends no message.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'stop', 'list', 'status', 'logs'],
            description: 'The action to perform on background processes',
          },
          name: {
            type: 'string',
            description: 'Display name for the process. Auto-generated from command if not provided.',
          },
          command: {
            type: 'string',
            description: 'Shell command to execute. Required for "start" action.',
          },
          cwd: {
            type: 'string',
            description: 'Working directory. Defaults to session workdir.',
          },
          timeout: {
            type: 'number',
            description: 'Maximum runtime in milliseconds. Process will be terminated after this duration.',
          },
          notifyOnExit: {
            type: 'boolean',
            description:
              'Queue a message to this session when the process ends on its own or by its timeout (exit code and last output lines). Default: false.',
          },
          processId: {
            type: 'string',
            description: 'Process ID. Required for stop, status, and logs actions.',
          },
          since: {
            type: 'number',
            description: 'Return logs after this offset. Default: 0',
          },
          maxLines: {
            type: 'number',
            description: 'Maximum lines to return. Default: 500, max: 2000',
          },
        },
        required: ['action'],
        dependentRequired: {
          start: ['command'],
          stop: ['processId'],
          status: ['processId'],
          logs: ['processId'],
        },
      },
    },
  },
  async (args, context, helpers) => {
    const result = await runBackgroundAction(context.sessionId, args.cwd ?? context.workdir, args)
    return result.ok ? helpers.success(result.output) : helpers.error(result.error)
  },
)
