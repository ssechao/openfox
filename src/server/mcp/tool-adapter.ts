import type { Tool, ToolContext } from '../tools/types.js'
import type { LLMToolDefinition } from '../llm/types.js'
import type { WorkerMcpTool } from '../session/worker/protocol.js'
import type { McpManager } from './manager.js'
import type { ToolResult } from '../../shared/types.js'
import { sanitizeToolSchema } from '../llm/schema-sanitizer.js'

export function normalizeMcpToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...args }
  if ('props' in normalized && !('properties' in normalized)) {
    normalized['properties'] = normalized['props']
    delete normalized['props']
  }
  return normalized
}

export function createWorkerMcpTools(mcpManager: McpManager): WorkerMcpTool[] {
  const tools: WorkerMcpTool[] = []
  for (const server of mcpManager.getAllServers()) {
    for (const mcpTool of server.tools) {
      if (!mcpTool.enabled) continue
      const name = `${server.name}_${mcpTool.name}`
      const definition: LLMToolDefinition = {
        type: 'function',
        function: {
          name,
          description: mcpTool.description ?? '',
          parameters: sanitizeToolSchema(mcpTool.inputSchema as Record<string, unknown>),
        },
      }
      tools.push({
        name,
        definition,
        serverName: server.name,
        toolName: mcpTool.name,
        ...(server.config.sessionIdInjection ? { sessionIdInjection: server.config.sessionIdInjection } : {}),
      })
    }
  }
  return tools
}

export function createMcpTools(mcpManager: McpManager): Tool[] {
  return createWorkerMcpTools(mcpManager).map((descriptor) => ({
    name: descriptor.name,
    definition: descriptor.definition,
    mcpServer: descriptor.serverName,
    execute: async (args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
      const start = Date.now()
      const result = await mcpManager.callTool(
        descriptor.serverName,
        descriptor.toolName,
        normalizeMcpToolArgs(args),
        context.sessionId,
      )
      return {
        success: result.success,
        ...(result.output ? { output: result.output } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.metadata ? { metadata: result.metadata } : {}),
        durationMs: Date.now() - start,
        truncated: false,
      }
    },
  }))
}
