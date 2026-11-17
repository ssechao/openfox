import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, writeFile, rm, readFile, chmod, stat, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `openfox-config-test-${Date.now()}`)

interface ConfigFaultInjection {
  syncOnTmp?: boolean
  rename?: boolean
  dirSync?: boolean
}

declare global {
  var __configFaults: ConfigFaultInjection | undefined
}

// Mock the paths module
vi.mock('./paths.js', () => ({
  getGlobalConfigPath: (mode: string) => join(TEST_DIR, mode, 'config.json'),
  getGlobalDataDir: (mode: string) => join(TEST_DIR, mode),
  getDatabasePath: (mode: string) => join(TEST_DIR, mode, 'sessions.db'),
  getAuthConfigPath: (mode: string) => join(TEST_DIR, mode, 'auth.json'),
  getAuthKeyPath: (mode: string) => join(TEST_DIR, mode, 'auth.key'),
  getSkillsDir: (mode: string) => join(TEST_DIR, mode, 'skills'),
  ensureDataDirExists: vi.fn(async () => {}),
}))

// Fault injection for the atomic write: fail while syncing or renaming the temp file.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const injected = (what: 'sync' | 'rename', path?: string): void => {
    const faults = globalThis.__configFaults
    if (!faults) return
    if (what === 'sync' && faults.syncOnTmp && typeof path === 'string' && path.includes('.tmp')) {
      throw new Error('injected fsync failure on temp file')
    }
    if (what === 'sync' && faults.dirSync && typeof path === 'string' && !path.includes('.tmp')) {
      throw new Error('injected fsync failure on directory')
    }
    if (what === 'rename' && faults.rename) {
      throw new Error('injected rename failure')
    }
  }
  return {
    ...actual,
    open: vi.fn(async (path: string, flags?: string | number, mode?: number | string) => {
      const handle = await actual.open(path, flags, mode)
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === 'sync') {
            return () => {
              injected('sync', path)
              return target.sync()
            }
          }
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }),
    rename: vi.fn(async (from: string, to: string) => {
      injected('rename', from)
      return actual.rename(from, to)
    }),
  }
})

vi.mock('../server/index.js', () => ({
  createServer: vi.fn(async () => {}),
}))

describe('config', () => {
  let loadGlobalConfig: typeof import('./config.js').loadGlobalConfig
  let saveGlobalConfig: typeof import('./config.js').saveGlobalConfig
  let getActiveProvider: typeof import('./config.js').getActiveProvider
  let getDefaultModel: typeof import('./config.js').getDefaultModel

  beforeEach(async () => {
    vi.resetModules()
    const configModule = await import('./config.js')
    loadGlobalConfig = configModule.loadGlobalConfig
    saveGlobalConfig = configModule.saveGlobalConfig
    getActiveProvider = configModule.getActiveProvider
    getDefaultModel = configModule.getDefaultModel

    await mkdir(join(TEST_DIR, 'production'), { recursive: true })
    await mkdir(join(TEST_DIR, 'development'), { recursive: true })
  })

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true })
  })

  describe('loadGlobalConfig', () => {
    it('returns empty providers for fresh install', async () => {
      const loaded = await loadGlobalConfig('production')

      expect(loaded.providers).toEqual([])
      expect(loaded.activeProviderId).toBeUndefined()
    })

    it('loads config with providers array', async () => {
      const config = {
        providers: [
          {
            id: 'test-123',
            name: 'Test Provider',
            url: 'http://localhost:8000/v1',
            backend: 'vllm' as const,
            models: [],
            isActive: true,
            createdAt: new Date().toISOString(),
          },
        ],
        defaultModelSelection: 'test-123/test-model',
        server: { port: 10369, host: '127.0.0.1', openBrowser: true },
        logging: { level: 'info' as const },
        database: { path: '' },
        workspace: { workdir: process.cwd() },
        visionFallback: {
          enabled: false,
          url: 'http://localhost:11434',
          model: 'qwen3.5:0.8b',
          timeout: 120,
          backend: 'ollama' as const,
        },
      }

      await writeFile(join(TEST_DIR, 'production', 'config.json'), JSON.stringify(config))
      const loaded = await loadGlobalConfig('production')

      expect(loaded.providers).toHaveLength(1)
      expect(loaded.providers[0]?.name).toBe('Test Provider')
      expect(loaded.defaultModelSelection).toBe('test-123/test-model')
    })

    it('preserves llm timeout config', async () => {
      const config = {
        providers: [],
        server: { port: 10369, host: '127.0.0.1', openBrowser: true },
        logging: { level: 'error' as const },
        database: { path: '' },
        workspace: { workdir: process.cwd() },
        llm: { timeout: 600000, idleTimeout: 600000 },
      }

      await writeFile(join(TEST_DIR, 'production', 'config.json'), JSON.stringify(config))
      const loaded = await loadGlobalConfig('production')

      expect(loaded.llm).toEqual({ timeout: 600000, idleTimeout: 600000 })
    })
  })

  describe('saveGlobalConfig', () => {
    it('saves config with providers array', async () => {
      const config = {
        providers: [
          {
            id: 'test-123',
            name: 'Test Provider',
            url: 'http://localhost:8000/v1',
            backend: 'vllm' as const,
            models: [],
            isActive: true,
            createdAt: new Date().toISOString(),
          },
        ],
        activeProviderId: 'test-123',
        server: { port: 10369, host: '127.0.0.1', openBrowser: true },
        logging: { level: 'info' as const },
        database: { path: '' },
        workspace: { workdir: process.cwd() },
        visionFallback: {
          enabled: false,
          url: 'http://localhost:11434',
          model: 'qwen3.5:0.8b',
          timeout: 120,
          backend: 'ollama' as const,
        },
      }

      await saveGlobalConfig('production', config)
      const loaded = await loadGlobalConfig('production')

      expect(loaded.providers).toHaveLength(1)
      expect(loaded.providers[0]?.name).toBe('Test Provider')
      expect(loaded.activeProviderId).toBe('test-123')
    })
  })

  describe('user-defined model context preservation', () => {
    it('preserves user-set contextWindow values across save/load cycle', async () => {
      const configWithUserModels = {
        providers: [
          {
            id: 'test-provider-123',
            name: 'Test Provider',
            url: 'http://localhost:8000/v1',
            backend: 'vllm' as const,
            models: [
              { id: 'model-x', contextWindow: 128000, source: 'user' as const },
              { id: 'model-y', contextWindow: 256000, source: 'user' as const },
            ],
            isActive: true,
            createdAt: new Date().toISOString(),
          },
        ],
        defaultModelSelection: 'test-provider-123/model-x',
        server: { port: 10369, host: '127.0.0.1', openBrowser: true },
        logging: { level: 'info' as const },
        database: { path: '' },
        workspace: { workdir: process.cwd() },
        visionFallback: {
          enabled: false,
          url: 'http://localhost:11434',
          model: 'qwen3.5:0.8b',
          timeout: 120,
          backend: 'ollama' as const,
        },
      }

      await saveGlobalConfig('production', configWithUserModels)
      const loaded = await loadGlobalConfig('production')

      expect(loaded.providers).toHaveLength(1)
      expect(loaded.providers[0]?.models).toEqual([
        { id: 'model-x', contextWindow: 128000, source: 'user' },
        { id: 'model-y', contextWindow: 256000, source: 'user' },
      ])
    })
  })

  describe('server host configuration', () => {
    it('saves and loads server.host = 0.0.0.0 for network access', async () => {
      const config = {
        providers: [],
        activeProviderId: undefined,
        server: { port: 10369, host: '0.0.0.0', openBrowser: true },
        logging: { level: 'info' as const },
        database: { path: '' },
        workspace: { workdir: process.cwd() },
        visionFallback: {
          enabled: false,
          url: 'http://localhost:11434',
          model: 'qwen3.5:0.8b',
          timeout: 120,
          backend: 'ollama' as const,
        },
      }

      await saveGlobalConfig('production', config)
      const loaded = await loadGlobalConfig('production')

      expect(loaded.server.host).toBe('0.0.0.0')
    })

    it('saves and loads server.host = 127.0.0.1 for localhost only', async () => {
      const config = {
        providers: [],
        activeProviderId: undefined,
        server: { port: 10369, host: '127.0.0.1', openBrowser: true },
        logging: { level: 'info' as const },
        database: { path: '' },
        workspace: { workdir: process.cwd() },
        visionFallback: {
          enabled: false,
          url: 'http://localhost:11434',
          model: 'qwen3.5:0.8b',
          timeout: 120,
          backend: 'ollama' as const,
        },
      }

      await saveGlobalConfig('production', config)
      const loaded = await loadGlobalConfig('production')

      expect(loaded.server.host).toBe('127.0.0.1')
    })

    it('preserves server.host when updating other settings', async () => {
      const originalConfig = {
        providers: [
          {
            id: 'test-123',
            name: 'Test Provider',
            url: 'http://localhost:8000/v1',
            backend: 'vllm' as const,
            models: [],
            isActive: true,
            createdAt: new Date().toISOString(),
          },
        ],
        activeProviderId: 'test-123',
        server: { port: 10369, host: '0.0.0.0', openBrowser: true },
        logging: { level: 'warn' as const },
        database: { path: '' },
        workspace: { workdir: process.cwd() },
        visionFallback: {
          enabled: false,
          url: 'http://localhost:11434',
          model: 'qwen3.5:0.8b',
          timeout: 120,
          backend: 'ollama' as const,
        },
      }

      await saveGlobalConfig('production', originalConfig)

      const updatedConfig = await loadGlobalConfig('production')
      updatedConfig.logging.level = 'error' as const

      await saveGlobalConfig('production', updatedConfig)
      const reloaded = await loadGlobalConfig('production')

      expect(reloaded.server.host).toBe('0.0.0.0')
      expect(reloaded.server.port).toBe(10369)
      expect(reloaded.logging.level).toBe('error')
      expect(reloaded.providers).toHaveLength(1)
    })

    it('handles model names with slashes in defaultModelSelection', async () => {
      const configWithSlashInModel = {
        providers: [
          {
            id: 'test-provider',
            name: 'Test Provider',
            url: 'http://localhost:8000/v1',
            backend: 'vllm' as const,
            models: [{ id: 'Intel/Qwen3.5-397B', contextWindow: 200000, source: 'user' as const }],
            isActive: true,
            createdAt: new Date().toISOString(),
          },
        ],
        defaultModelSelection: 'test-provider/Intel/Qwen3.5-397B',
        server: { port: 10369, host: '127.0.0.1', openBrowser: true },
        logging: { level: 'info' as const },
        database: { path: '' },
        workspace: { workdir: process.cwd() },
      }

      await writeFile(join(TEST_DIR, 'production', 'config.json'), JSON.stringify(configWithSlashInModel))
      const loaded = await loadGlobalConfig('production')

      expect(loaded.defaultModelSelection).toBe('test-provider/Intel/Qwen3.5-397B')

      const activeProvider = getActiveProvider(loaded)
      expect(activeProvider?.id).toBe('test-provider')

      const defaultModel = getDefaultModel(loaded)
      expect(defaultModel).toBe('Intel/Qwen3.5-397B')
    })
  })

  describe('mcpServers config', () => {
    it('should parse valid mcpServers config', async () => {
      const raw = {
        providers: [],
        mcpServers: {
          brave: {
            transport: 'stdio',
            command: 'npx',
            args: ['@brave/brave-search-mcp-server'],
            env: { BRAVE_API_KEY: 'test-key' },
          },
          filesystem: {
            transport: 'stdio',
            command: 'node',
            args: ['server.js', '/tmp'],
          },
        },
      }

      await writeFile(join(TEST_DIR, 'production', 'config.json'), JSON.stringify(raw))
      const loaded = await loadGlobalConfig('production')

      expect(loaded.mcpServers).toBeDefined()
      expect(Object.keys(loaded.mcpServers!)).toEqual(['brave', 'filesystem'])
      expect(loaded.mcpServers!['brave']!.command).toBe('npx')
      expect(loaded.mcpServers!['brave']!.transport).toBe('stdio')
      expect(loaded.mcpServers!['brave']!.env).toEqual({ BRAVE_API_KEY: 'test-key' })
      expect(loaded.mcpServers!['filesystem']!.args).toEqual(['server.js', '/tmp'])
    })

    it('should parse mcpServers with disabledTools', async () => {
      const raw = {
        providers: [],
        mcpServers: {
          test: {
            transport: 'stdio',
            command: 'node',
            disabledTools: ['tool_a', 'tool_b'],
          },
        },
      }

      await writeFile(join(TEST_DIR, 'production', 'config.json'), JSON.stringify(raw))
      const loaded = await loadGlobalConfig('production')

      expect(loaded.mcpServers!['test']!.disabledTools).toEqual(['tool_a', 'tool_b'])
    })

    it('should preserve sessionIdInjection through save and load cycle', async () => {
      const raw = {
        providers: [],
        mcpServers: {
          'mcp-lazy': {
            transport: 'stdio' as const,
            command: 'node',
            sessionIdInjection: { 'llm-aether': 'session_id' },
          },
        },
      }

      await writeFile(join(TEST_DIR, 'production', 'config.json'), JSON.stringify(raw))
      const loaded = await loadGlobalConfig('production')

      expect(loaded.mcpServers!['mcp-lazy']!.sessionIdInjection).toEqual({ 'llm-aether': 'session_id' })

      await saveGlobalConfig('production', loaded)
      const reloaded = await loadGlobalConfig('production')

      expect(reloaded.mcpServers!['mcp-lazy']!.sessionIdInjection).toEqual({ 'llm-aether': 'session_id' })
    })

    it('should handle missing mcpServers', async () => {
      const loaded = await loadGlobalConfig('production')
      expect(loaded.mcpServers).toBeUndefined()
    })

    it('should preserve mcpServers through save and load cycle', async () => {
      const raw = {
        providers: [],
        mcpServers: {
          brave: {
            transport: 'stdio' as const,
            command: 'npx',
            args: ['@brave/brave-search-mcp-server'],
          },
        },
      }

      await saveGlobalConfig('test', raw)
      const loaded = await loadGlobalConfig('test')
      expect(loaded.mcpServers).toBeDefined()
      expect(loaded.mcpServers!['brave']!.command).toBe('npx')
    })
  })

  it('preserves provider auth fields when loading config', async () => {
    const configPath = join(TEST_DIR, 'production', 'config.json')
    await mkdir(join(TEST_DIR, 'production'), { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify({
        providers: [
          {
            id: 'external',
            name: 'External Account Provider',
            url: 'https://provider.example/v1',
            backend: 'openai',
            models: [],
            isActive: true,
            createdAt: new Date().toISOString(),
            authAdapter: 'example-auth',
            transportAdapter: 'example-transport',
            credentialRef: 'credential-ref-1',
            logo: 'https://example.com/provider-logo.png',
          },
        ],
        defaultModelSelection: 'external/gpt-5.4',
      }),
    )

    const loaded = await loadGlobalConfig('production')
    expect(loaded.providers[0]).toEqual(
      expect.objectContaining({
        authAdapter: 'example-auth',
        transportAdapter: 'example-transport',
        credentialRef: 'credential-ref-1',
        logo: 'https://example.com/provider-logo.png',
      }),
    )
  })

  it('accepts a concise preset-backed provider entry', async () => {
    await writeFile(
      join(TEST_DIR, 'production', 'config.json'),
      JSON.stringify({ providers: [{ id: 'main', preset: 'example' }] }),
    )

    const loaded = await loadGlobalConfig('production')
    expect(loaded.providers).toEqual([
      expect.objectContaining({
        id: 'main',
        preset: 'example',
        name: 'main',
        url: '',
        backend: 'unknown',
        models: [],
        isActive: false,
      }),
    ])
  })

  describe('atomic write and explicit read failure (config-atomic-write)', () => {
    const configPath = join(TEST_DIR, 'production', 'config.json')

    const longProvider = {
      id: 'long-provider',
      name: 'A provider with a long entry so the first config is much bigger than the second one',
      url: 'http://long.example.com:9999/v1/completions',
      backend: 'vllm' as const,
      models: [{ id: 'model-a', contextWindow: 200000, source: 'user' as const }],
      isActive: true,
      createdAt: new Date().toISOString(),
    }

    function tmpLeftovers(): Promise<string[]> {
      return readdir(dirname(configPath)).then((files) => files.filter((f) => f.includes('.tmp')))
    }

    it('config write shorter than the existing file leaves valid JSON without trailing data', async () => {
      await saveGlobalConfig('production', { providers: [longProvider], activeProviderId: 'long-provider' })
      await chmod(configPath, 0o600)
      const before = await readFile(configPath)
      expect(before.length).toBeGreaterThan(200)

      globalThis.__configFaults = { syncOnTmp: true }
      let rejected = false
      try {
        await saveGlobalConfig('production', { providers: [] })
      } catch {
        rejected = true
      }
      globalThis.__configFaults = undefined

      expect(rejected).toBe(true)
      expect((await readFile(configPath)).equals(before)).toBe(true)
      expect((await stat(configPath)).mode & 0o777).toBe(0o600)
      expect(await tmpLeftovers()).toEqual([])

      await saveGlobalConfig('production', { providers: [] })
      const content = await readFile(configPath, 'utf-8')
      expect(() => JSON.parse(content)).not.toThrow()
      expect((await stat(configPath)).mode & 0o777).toBe(0o600)
      expect(await tmpLeftovers()).toEqual([])
      const reloaded = await loadGlobalConfig('production')
      expect(reloaded.providers).toEqual([])
    })

    it('interrupted config write leaves the previous file intact', async () => {
      await saveGlobalConfig('production', { providers: [longProvider], activeProviderId: 'long-provider' })
      const before = await readFile(configPath)

      globalThis.__configFaults = { rename: true }
      let rejected = false
      try {
        await saveGlobalConfig('production', { providers: [] })
      } catch {
        rejected = true
      }
      globalThis.__configFaults = undefined

      expect(rejected).toBe(true)
      expect((await readFile(configPath)).equals(before)).toBe(true)
      expect(await tmpLeftovers()).toEqual([])
      const reloaded = await loadGlobalConfig('production')
      expect(reloaded.providers).toHaveLength(1)
      expect(reloaded.activeProviderId).toBe('long-provider')
    })

    it('missing config.json keeps first-run behaviour', async () => {
      const loaded = await loadGlobalConfig('production')
      expect(loaded.providers).toEqual([])
    })

    it('corrupted config.json fails startup with explicit path and position', async () => {
      const configModule = (await import('./config.js')) as unknown as Record<string, unknown>
      const ConfigError = configModule['ConfigError'] as new (message: string) => Error
      await writeFile(configPath, '{"providers":[]}\n{"extra": 1}\n')

      await expect(loadGlobalConfig('production')).rejects.toBeInstanceOf(ConfigError)
      await expect(loadGlobalConfig('production')).rejects.toThrow(configPath)
      await expect(loadGlobalConfig('production')).rejects.toThrow(/position \d+|line \d+ column \d+/)

      await writeFile(configPath, JSON.stringify({ providers: [{ id: 'x', backend: 'bogus' }] }))
      await expect(loadGlobalConfig('production')).rejects.toBeInstanceOf(ConfigError)
      await expect(loadGlobalConfig('production')).rejects.toThrow(configPath)
      await expect(loadGlobalConfig('production')).rejects.toThrow(/providers\.0\.backend/)
    })

    it('rejects explicit null section values instead of falling back to defaults', async () => {
      const configModule = (await import('./config.js')) as unknown as Record<string, unknown>
      const ConfigError = configModule['ConfigError'] as new (message: string) => Error
      await writeFile(configPath, JSON.stringify({ providers: null, server: null }))

      await expect(loadGlobalConfig('production')).rejects.toBeInstanceOf(ConfigError)
      await expect(loadGlobalConfig('production')).rejects.toThrow(/providers/)
      await expect(loadGlobalConfig('production')).rejects.toThrow(/server/)
    })

    it('rejects an unknown apiProtocol enum value with its full path', async () => {
      const configModule = (await import('./config.js')) as unknown as Record<string, unknown>
      const ConfigError = configModule['ConfigError'] as new (message: string) => Error
      await writeFile(
        configPath,
        JSON.stringify({
          providers: [{ id: 'p', name: 'p', url: 'http://x', backend: 'unknown', apiProtocol: 'bogus' }],
        }),
      )

      await expect(loadGlobalConfig('production')).rejects.toBeInstanceOf(ConfigError)
      await expect(loadGlobalConfig('production')).rejects.toThrow(/providers\.0\.apiProtocol/)
    })

    it('invalid JSON diagnostic is neutral and never leaks file content', async () => {
      const configModule = (await import('./config.js')) as unknown as Record<string, unknown>
      const ConfigError = configModule['ConfigError'] as new (message: string) => Error
      await writeFile(configPath, '{"apiKey": "SENTINELLE-NE-PAS-FUITER" broken}')

      let error: unknown
      await loadGlobalConfig('production').then(
        () => undefined,
        (err: unknown) => {
          error = err
        },
      )
      expect(error).toBeInstanceOf(ConfigError)
      expect((error as Error).message).toContain(configPath)
      expect((error as Error).message).toMatch(/position \d+|line \d+ column \d+/)
      expect((error as Error).message).not.toContain('SENTINELLE-NE-PAS-FUITER')
    })

    it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
      'unreadable config file raises an explicit error naming the path',
      async () => {
        const configModule = (await import('./config.js')) as unknown as Record<string, unknown>
        const ConfigError = configModule['ConfigError'] as new (message: string) => Error
        await saveGlobalConfig('production', { providers: [] })
        await chmod(configPath, 0o000)
        try {
          let error: unknown
          await loadGlobalConfig('production').then(
            () => undefined,
            (err: unknown) => {
              error = err
            },
          )
          expect(error).toBeInstanceOf(ConfigError)
          expect((error as Error).message).toContain(configPath)
        } finally {
          await chmod(configPath, 0o600)
        }
      },
    )

    it('startup on broken JSON exits with code 1, logs once, and does not leak secrets', async () => {
      await writeFile(configPath, '{"providers": [{"apiKey": "SENTINELLE-DEMARRAGE"} broken}')

      const { runServe } = await import('./serve.js')
      const { createServer } = await import('../server/index.js')
      const { logger } = await import('../server/utils/logger.js')

      class ExitSentinel extends Error {
        constructor(public readonly exitCode: number | undefined) {
          super(`process.exit:${String(exitCode)}`)
        }
      }
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new ExitSentinel(code)
      }) as never)
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      let exitCode: number | null | 'no-exit' = 'no-exit'
      let logged: unknown[][] = []
      let consoleCalls: unknown[][] = []
      try {
        await runServe({ mode: 'production', openBrowser: false })
      } catch (err) {
        if (err instanceof ExitSentinel) exitCode = err.exitCode ?? null
      } finally {
        logged = errorSpy.mock.calls.map((call) => [...call])
        consoleCalls = consoleSpy.mock.calls.map((call) => [...call])
        exitSpy.mockRestore()
        errorSpy.mockRestore()
        consoleSpy.mockRestore()
      }

      expect(exitCode).toBe(1)
      expect(logged).toHaveLength(1)
      expect(consoleCalls).toHaveLength(0)
      expect(String(logged[0]![0])).toContain(configPath)
      expect(String(logged[0]![0])).not.toContain('SENTINELLE-DEMARRAGE')
      expect(createServer).not.toHaveBeenCalled()
    })

    it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
      'startup on unreadable config file exits with code 1',
      async () => {
        await saveGlobalConfig('production', { providers: [] })
        await chmod(configPath, 0o000)

        const { runServe } = await import('./serve.js')
        const { logger } = await import('../server/utils/logger.js')

        class ExitSentinel extends Error {
          constructor(public readonly exitCode: number | undefined) {
            super(`process.exit:${String(exitCode)}`)
          }
        }
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
          throw new ExitSentinel(code)
        }) as never)
        const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})

        let exitCode: number | null | 'no-exit' = 'no-exit'
        let logged: unknown[][] = []
        try {
          await runServe({ mode: 'production', openBrowser: false })
        } catch (err) {
          if (err instanceof ExitSentinel) exitCode = err.exitCode ?? null
        } finally {
          logged = errorSpy.mock.calls.map((call) => [...call])
          await chmod(configPath, 0o600)
          exitSpy.mockRestore()
          errorSpy.mockRestore()
        }

        expect(exitCode).toBe(1)
        expect(logged.some((call) => String(call[0]).includes(configPath))).toBe(true)
      },
    )

    it('directory fsync failure after rename surfaces an explicit error without losing the write', async () => {
      const configModule = (await import('./config.js')) as unknown as Record<string, unknown>
      const ConfigError = configModule['ConfigError'] as new (message: string) => Error
      await saveGlobalConfig('production', { providers: [] })

      globalThis.__configFaults = { dirSync: true }
      let error: unknown
      try {
        await saveGlobalConfig('production', { providers: [longProvider] })
      } catch (err) {
        error = err
      } finally {
        globalThis.__configFaults = undefined
      }

      expect(error).toBeInstanceOf(ConfigError)
      expect((error as Error).message).toContain(configPath)
      const written = JSON.parse(await readFile(configPath, 'utf-8'))
      expect(written.providers).toHaveLength(1)
      expect(await tmpLeftovers()).toEqual([])
    })
  })

  describe('provider apiProtocol', () => {
    it('survives a save/load round-trip (the schema must not strip it)', async () => {
      const provider = {
        id: 'innovup',
        name: 'InnovUp Provider',
        url: 'http://192.168.71.122:3457/v1',
        backend: 'unknown' as const,
        models: [],
        isActive: true,
        createdAt: new Date().toISOString(),
        apiProtocol: 'responses' as const,
      }

      await saveGlobalConfig('production', { providers: [provider] })
      const loaded = await loadGlobalConfig('production')

      expect(loaded.providers[0]?.apiProtocol).toBe('responses')
    })

    it('rejects an unknown apiProtocol value instead of silently dropping it', async () => {
      const configModule = (await import('./config.js')) as unknown as Record<string, unknown>
      const ConfigError = configModule['ConfigError'] as new (message: string) => Error
      await writeFile(
        join(TEST_DIR, 'production', 'config.json'),
        JSON.stringify({
          providers: [{ id: 'p', name: 'p', url: 'http://x', backend: 'unknown', apiProtocol: 'bogus' }],
        }),
      )

      await expect(loadGlobalConfig('production')).rejects.toBeInstanceOf(ConfigError)
    })
  })
})

describe('resolveVisionFallback', () => {
  let resolveVisionFallback: typeof import('./config.js').resolveVisionFallback
  let getVisionFallback: typeof import('./config.js').getVisionFallback

  beforeEach(async () => {
    vi.resetModules()
    const configModule = await import('./config.js')
    resolveVisionFallback = configModule.resolveVisionFallback
    getVisionFallback = configModule.getVisionFallback
  })

  const visionProvider = {
    id: 'vision-provider',
    name: 'Vision Provider',
    url: 'http://vision-server:8000/v1',
    backend: 'openai' as const,
    apiKey: 'sk-test-key-123',
    models: [
      { id: 'gpt-4o-vision', contextWindow: 128000, source: 'backend' as const, supportsVision: true },
      { id: 'gpt-4o-mini', contextWindow: 64000, source: 'backend' as const, supportsVision: true },
      { id: 'text-only-model', contextWindow: 32000, source: 'backend' as const },
    ],
    isActive: true,
    createdAt: new Date().toISOString(),
  }

  function makeConfig(overrides?: Record<string, unknown>): any {
    return {
      providers: [visionProvider],
      server: { port: 10369, host: '127.0.0.1', openBrowser: true },
      logging: { level: 'error' as const },
      database: { path: '' },
      workspace: { workdir: process.cwd() },
      visionFallback: {
        enabled: false,
        url: 'http://localhost:11434',
        model: 'qwen3.5:0.8b',
        timeout: 120,
        backend: 'ollama' as const,
      },
      ...overrides,
    }
  }

  it('resolves a valid providerModelRef to the correct provider/model', () => {
    const config = makeConfig({
      visionFallback: {
        enabled: true,
        providerModelRef: 'vision-provider/gpt-4o-vision',
        timeout: 120,
      },
    })
    const result = resolveVisionFallback(config)
    expect(result).toBeDefined()
    expect(result!.baseUrl).toBe('http://vision-server:8000/v1')
    expect(result!.model).toBe('gpt-4o-vision')
    expect(result!.timeout).toBe(120 * 1000)
    expect(result!.backend).toBe('openai')
    expect(result!.apiKey).toBe('sk-test-key-123')
  })

  it('falls back to legacy fields when providerModelRef is absent', () => {
    const config = makeConfig({
      visionFallback: {
        enabled: true,
        url: 'http://legacy-server:11434',
        model: 'llava',
        timeout: 60,
        backend: 'ollama' as const,
      },
    })
    const result = resolveVisionFallback(config)
    expect(result).toBeDefined()
    expect(result!.baseUrl).toBe('http://legacy-server:11434')
    expect(result!.model).toBe('llava')
    expect(result!.timeout).toBe(60 * 1000)
    expect(result!.backend).toBe('ollama')
    expect(result!.apiKey).toBeUndefined()
  })

  it('passes the api key through when the manual config sets one', () => {
    const config = makeConfig({
      visionFallback: {
        enabled: true,
        url: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        timeout: 120,
        backend: 'openai' as const,
        apiKey: 'sk-manual-key',
      },
    })
    const result = resolveVisionFallback(config)
    expect(result).toBeDefined()
    expect(result!.baseUrl).toBe('https://api.openai.com/v1')
    expect(result!.backend).toBe('openai')
    expect(result!.apiKey).toBe('sk-manual-key')
  })

  it('keeps using the provider key when providerModelRef resolves', () => {
    const config = makeConfig({
      visionFallback: {
        enabled: true,
        providerModelRef: 'vision-provider/gpt-4o-vision',
        url: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        timeout: 120,
        backend: 'openai' as const,
        apiKey: 'sk-manual-key',
      },
    })
    const result = resolveVisionFallback(config)
    expect(result).toBeDefined()
    expect(result!.apiKey).toBe('sk-test-key-123')
  })

  it('handles provider-not-found gracefully by falling back to legacy', () => {
    const config = makeConfig({
      visionFallback: {
        enabled: true,
        providerModelRef: 'nonexistent-provider/gpt-4o-vision',
        url: 'http://fallback:11434',
        model: 'fallback-model',
        timeout: 30,
        backend: 'ollama' as const,
      },
    })
    const result = resolveVisionFallback(config)
    expect(result).toBeDefined()
    expect(result!.baseUrl).toBe('http://fallback:11434')
    expect(result!.model).toBe('fallback-model')
  })

  it('handles model-not-found gracefully by falling back to first vision-capable model', () => {
    const config = makeConfig({
      visionFallback: {
        enabled: true,
        providerModelRef: 'vision-provider/nonexistent-model',
        timeout: 120,
      },
    })
    const result = resolveVisionFallback(config)
    expect(result).toBeDefined()
    expect(result!.model).toBe('gpt-4o-vision')
    expect(result!.baseUrl).toBe('http://vision-server:8000/v1')
    expect(result!.backend).toBe('openai')
  })

  it('disables vision fallback when provider ref has no vision-capable models', () => {
    const noVisionProvider = {
      ...visionProvider,
      id: 'no-vision-provider',
      models: [{ id: 'text-model', contextWindow: 32000, source: 'backend' as const }],
    }
    const config = makeConfig({
      providers: [noVisionProvider],
      visionFallback: {
        enabled: true,
        providerModelRef: 'no-vision-provider/text-model',
        url: 'http://fallback:11434',
        model: 'fallback-model',
        timeout: 30,
        backend: 'ollama' as const,
      },
    })
    const result = resolveVisionFallback(config)
    expect(result).toBeDefined()
    expect(result!.baseUrl).toBe('http://fallback:11434')
    expect(result!.model).toBe('fallback-model')
  })

  it('returns undefined when vision fallback is disabled', () => {
    const config = makeConfig({
      visionFallback: {
        enabled: false,
        providerModelRef: 'vision-provider/gpt-4o-vision',
      },
    })
    const result = resolveVisionFallback(config)
    expect(result).toBeUndefined()
  })

  it('includes apiKey when the provider has one', () => {
    const config = makeConfig({
      visionFallback: {
        enabled: true,
        providerModelRef: 'vision-provider/gpt-4o-mini',
        timeout: 120,
      },
    })
    const result = resolveVisionFallback(config)
    expect(result).toBeDefined()
    expect(result!.apiKey).toBe('sk-test-key-123')
    expect(result!.model).toBe('gpt-4o-mini')
  })

  it('omits apiKey when the provider has none', () => {
    const providerNoKey = {
      ...visionProvider,
      apiKey: undefined,
    }
    const config = makeConfig({
      providers: [providerNoKey],
      visionFallback: {
        enabled: true,
        providerModelRef: 'vision-provider/gpt-4o-vision',
        timeout: 120,
      },
    })
    const result = resolveVisionFallback(config)
    expect(result).toBeDefined()
    expect(result!.apiKey).toBeUndefined()
  })

  it('retains providerModelRef in config even when provider is missing (graceful degradation)', () => {
    const config = makeConfig({
      providers: [],
      visionFallback: {
        enabled: true,
        providerModelRef: 'deleted-provider/some-model',
        url: 'http://fallback:11434',
        model: 'fallback-model',
        timeout: 30,
        backend: 'ollama' as const,
      },
    })
    const result = resolveVisionFallback(config)
    expect(result).toBeDefined()
    expect(result!.baseUrl).toBe('http://fallback:11434')
    expect(getVisionFallback(config).providerModelRef).toBe('deleted-provider/some-model')
  })

  it('falls back to default url when provider has no url and fallback.url is undefined', () => {
    const providerNoUrl = {
      ...visionProvider,
      url: '',
      apiKey: undefined,
    }
    const config = makeConfig({
      providers: [providerNoUrl],
      visionFallback: {
        enabled: true,
        providerModelRef: 'vision-provider/gpt-4o-vision',
        url: '',
        timeout: 60,
      },
    })
    const result = resolveVisionFallback(config)
    expect(result).toBeDefined()
    expect(result!.baseUrl).toBe('http://localhost:11434')
    expect(result!.model).toBe('gpt-4o-vision')
    expect(result!.timeout).toBe(60 * 1000)
  })

  it('returns legacy fallback when providerModelRef is empty string', () => {
    const config = makeConfig({
      visionFallback: {
        enabled: true,
        providerModelRef: '',
        url: 'http://manual:11434',
        model: 'manual-model',
        timeout: 30,
        backend: 'ollama' as const,
      },
    })
    const result = resolveVisionFallback(config)
    expect(result).toBeDefined()
    expect(result!.baseUrl).toBe('http://manual:11434')
    expect(result!.model).toBe('manual-model')
  })

  it('handles ref without slash gracefully', () => {
    const config = makeConfig({
      visionFallback: {
        enabled: true,
        providerModelRef: 'no-slash-here',
        url: 'http://fallback:11434',
        model: 'fallback-model',
        timeout: 30,
        backend: 'ollama' as const,
      },
    })
    const result = resolveVisionFallback(config)
    expect(result).toBeDefined()
    expect(result!.baseUrl).toBe('http://fallback:11434')
    expect(result!.model).toBe('fallback-model')
  })

  it('handles empty provider models array', () => {
    const providerEmptyModels = {
      ...visionProvider,
      id: 'empty-models',
      models: [],
    }
    const config = makeConfig({
      providers: [providerEmptyModels],
      visionFallback: {
        enabled: true,
        providerModelRef: 'empty-models/gpt-4o-vision',
        url: 'http://fallback:11434',
        model: 'fallback-model',
        timeout: 30,
        backend: 'ollama' as const,
      },
    })
    const result = resolveVisionFallback(config)
    expect(result).toBeDefined()
    expect(result!.baseUrl).toBe('http://fallback:11434')
    expect(result!.model).toBe('fallback-model')
  })

  it('returns undefined when fallback.url is undefined in legacy mode', () => {
    const config = makeConfig({
      visionFallback: {
        enabled: true,
        url: '',
        model: 'some-model',
        timeout: 30,
        backend: 'ollama' as const,
      },
    })
    const result = resolveVisionFallback(config)
    expect(result).toBeUndefined()
  })
})

describe('reorderProviders', () => {
  let reorderProviders: (typeof import('./config.js'))['reorderProviders']

  beforeEach(async () => {
    vi.resetModules()
    const configModule = await import('./config.js')
    reorderProviders = configModule.reorderProviders
  })

  function makeProviderConfig(): any {
    return {
      providers: ['a', 'b', 'c'].map((id) => ({
        id,
        name: `Provider ${id.toUpperCase()}`,
        url: `http://localhost/${id}`,
        backend: 'vllm' as const,
        models: [],
        isActive: id === 'b',
        createdAt: new Date().toISOString(),
      })),
      defaultModelSelection: 'b/some-model',
      activeProviderId: 'b',
      server: { port: 10369, host: '127.0.0.1', openBrowser: true },
      logging: { level: 'info' as const },
      database: { path: '' },
      workspace: { workdir: process.cwd() },
    }
  }

  it('reorders providers to match orderedIds', () => {
    const config = makeProviderConfig()
    const result = reorderProviders(config, ['c', 'a', 'b'])

    expect(result.providers.map((p) => p.id)).toEqual(['c', 'a', 'b'])
    expect(result.providers.map((p) => p.name)).toEqual(['Provider C', 'Provider A', 'Provider B'])
  })

  it('preserves other config fields (defaultModelSelection, activeProviderId, server)', () => {
    const config = makeProviderConfig()
    const result = reorderProviders(config, ['b', 'c', 'a'])

    expect(result.defaultModelSelection).toBe('b/some-model')
    expect(result.activeProviderId).toBe(config.activeProviderId)
    expect(result.server).toEqual(config.server)
  })

  it('returns a new config object and does not mutate the input', () => {
    const config = makeProviderConfig()
    const originalIds = config.providers.map((p: any) => p.id)
    const result = reorderProviders(config, ['c', 'b', 'a'])

    expect(result).not.toBe(config)
    expect(config.providers.map((p: any) => p.id)).toEqual(originalIds)
  })

  it('throws when orderedIds misses a provider', () => {
    const config = makeProviderConfig()
    expect(() => reorderProviders(config, ['a', 'b'])).toThrow()
  })

  it('throws when orderedIds contains an unknown provider id', () => {
    const config = makeProviderConfig()
    expect(() => reorderProviders(config, ['a', 'b', 'c', 'zzz'])).toThrow()
  })

  it('throws when orderedIds contains duplicates', () => {
    const config = makeProviderConfig()
    expect(() => reorderProviders(config, ['a', 'b', 'b'])).toThrow()
  })
})
