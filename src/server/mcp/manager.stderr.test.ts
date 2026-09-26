import { describe, expect, it } from 'vitest'
import { McpManager } from './manager.js'

// A real stdio server that must flush more than a pipe can hold before responding.
// The deadline also terminates it if a regression leaves initialization blocked.
const noisyServer = String.raw`
  const { createInterface } = require('node:readline');
  const input = createInterface({ input: process.stdin });
  const deadline = setTimeout(() => process.exit(1), 10_000);
  input.on('close', () => process.exit(0));

  (async () => {
    for await (const line of input) {
      const request = JSON.parse(line);
      if (request.id === undefined) continue;

      await new Promise((resolve, reject) => {
        process.stderr.write('diagnostic log\n'.repeat(131_072), error => {
          if (error) reject(error);
          else resolve();
        });
      });

      let result;
      if (request.method === 'initialize') {
        result = {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'noisy-test-server', version: '1.0.0' },
        };
      } else if (request.method === 'tools/list') {
        result = { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] };
      } else if (request.method === 'tools/call') {
        result = { content: [{ type: 'text', text: 'pong' }] };
      } else {
        throw new Error('Unexpected method: ' + request.method);
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    }
    clearTimeout(deadline);
  })().catch(() => process.exit(1));
`

describe('McpManager stdio stderr', () => {
  it('keeps discovery and tool calls responsive under heavy stderr output, including after reconnect', async () => {
    const manager = new McpManager()

    try {
      await manager.addServer('noisy', {
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', noisyServer],
      })

      expect(manager.getServer('noisy')?.status).toBe('connected')
      expect(manager.getServer('noisy')?.tools.map((tool) => tool.name)).toEqual(['ping'])
      expect(await manager.callTool('noisy', 'ping', {})).toEqual({ success: true, output: 'pong' })
      expect(await manager.callTool('noisy', 'ping', {})).toEqual({ success: true, output: 'pong' })

      await manager.reconnectServer('noisy')
      expect(manager.getServer('noisy')?.status).toBe('connected')
      expect(await manager.callTool('noisy', 'ping', {})).toEqual({ success: true, output: 'pong' })
    } finally {
      await manager.disconnectAll()
    }
  })
})
