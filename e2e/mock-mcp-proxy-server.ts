const tools = [
  {
    name: 'mcp_execute_tool',
    description: 'Execute a target MCP tool',
    inputSchema: {
      type: 'object',
      properties: {
        server_name: { type: 'string' },
        tool_name: { type: 'string' },
        arguments: { type: 'object' },
      },
      required: ['server_name', 'tool_name', 'arguments'],
    },
  },
]

let initialized = false

function sendMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handleMessage(raw: string): void {
  let message: { id?: unknown; method?: string; params?: unknown }
  try {
    message = JSON.parse(raw) as { id?: unknown; method?: string; params?: unknown }
  } catch {
    return
  }

  if (message.method === 'initialize') {
    initialized = true
    sendMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp-proxy-server', version: '1.0.0' },
      },
    })
    return
  }
  if (message.method === 'notifications/initialized') return
  if (!initialized) return
  if (message.method === 'tools/list') {
    sendMessage({ jsonrpc: '2.0', id: message.id, result: { tools } })
    return
  }
  if (message.method === 'tools/call') {
    const params = message.params as { name?: string; arguments?: Record<string, unknown> }
    if (params.name !== 'mcp_execute_tool') {
      sendMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool' } })
      return
    }
    sendMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(params.arguments?.['arguments'] ?? {}) }],
        isError: false,
      },
    })
    return
  }
  if (message.method === 'ping') sendMessage({ jsonrpc: '2.0', id: message.id, result: {} })
}

const lines = (await import('node:readline')).createInterface({ input: process.stdin })
lines.on('line', handleMessage)
lines.on('close', () => process.exit(0))
