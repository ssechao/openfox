import { describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import express from 'express'
import { CommandAbortedError, runFile } from './bounded-exec.js'
import { requestAbortSignal } from './request-abort.js'

const DISCONNECT_HANDLER_MS = 5_000

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition')
    await sleep(10)
  }
}

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(app)
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()))
  return { server, port: (server.address() as AddressInfo).port }
}

async function stop(server: http.Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
}

function postAndDisconnect(port: number, path: string, body: unknown, afterMs: number): Promise<void> {
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })
  req.on('error', () => {})
  req.end(JSON.stringify(body))
  return sleep(afterMs).then(() => {
    req.destroy()
  })
}

function slowJsonApp() {
  const handled: Array<{ aborted: boolean; elapsedMs: number }> = []
  const signals: AbortSignal[] = []
  const app = express()
  app.use(express.json())
  app.post('/slow', async (req, res) => {
    const { delayMs, deferSignal } = req.body as { delayMs: number; deferSignal: boolean }
    if (deferSignal) await new Promise<void>((resolve) => setImmediate(resolve))
    const signal = requestAbortSignal(res)
    signals.push(signal)
    const started = performance.now()
    await sleep(delayMs, undefined, { signal }).catch(() => undefined)
    handled.push({ aborted: signal.aborted, elapsedMs: performance.now() - started })
    if (!res.destroyed) res.json({ aborted: signal.aborted, body: req.body })
  })
  return { app, handled, signals }
}

describe('requestAbortSignal', () => {
  describe.each([
    ['in the first tick of the handler', false],
    ['after an await, as the real routes do', true],
  ])('signal requested %s (real express + express.json())', (_when, deferSignal) => {
    it('stays live for a JSON POST whose client waits for a 300 ms handler', async () => {
      const { app, handled, signals } = slowJsonApp()
      const { server, port } = await listen(app)
      try {
        const response = await fetch(`http://127.0.0.1:${port}/slow`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ delayMs: 300, deferSignal }),
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ aborted: false, body: { delayMs: 300, deferSignal } })
        expect(handled).toHaveLength(1)
        expect(handled[0]!.aborted).toBe(false)
        expect(handled[0]!.elapsedMs).toBeGreaterThanOrEqual(250)
        await sleep(50)
        expect(signals[0]!.aborted).toBe(false)
      } finally {
        await stop(server)
      }
    })

    it('aborts before the handler ends when the client disconnects at 100 ms', async () => {
      const { app, handled } = slowJsonApp()
      const { server, port } = await listen(app)
      try {
        await postAndDisconnect(port, '/slow', { delayMs: DISCONNECT_HANDLER_MS, deferSignal }, 100)
        await until(() => handled.length === 1)
        expect(handled[0]!.aborted).toBe(true)
        expect(handled[0]!.elapsedMs).toBeLessThan(DISCONNECT_HANDLER_MS)
      } finally {
        await stop(server)
      }
    })
  })

  it('is already aborted when the client left before the handler asked for it', async () => {
    const seen: boolean[] = []
    const app = express()
    app.use(express.json())
    app.post('/late', async (_req, res) => {
      await once(res, 'close')
      seen.push(requestAbortSignal(res).aborted)
    })
    const { server, port } = await listen(app)
    try {
      await postAndDisconnect(port, '/late', { any: 'body' }, 100)
      await until(() => seen.length === 1)
      expect(seen).toEqual([true])
    } finally {
      await stop(server)
    }
  })

  it('kills the in-flight subprocess when the HTTP client disconnects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openfox-req-abort-'))
    const pidFile = join(dir, 'child.pid')
    const script = [
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'setInterval(()=>{},1000)',
    ].join('')

    const server = http.createServer((_req, res) => {
      const signal = requestAbortSignal(res)
      void runFile(process.execPath, ['-e', script], { signal, timeoutMs: 15_000 }).then(
        () => {
          if (!res.writableEnded) res.end('ok')
        },
        (err: unknown) => {
          if (res.writableEnded) return
          res.statusCode = err instanceof CommandAbortedError ? 499 : 500
          res.end(err instanceof Error ? err.message : 'error')
        },
      )
    })

    await new Promise<void>((ready) => {
      server.listen(0, '127.0.0.1', () => ready())
    })
    const port = (server.address() as AddressInfo).port

    try {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/' })
      req.on('error', () => {})

      const deadline = Date.now() + 5_000
      let pid = 0
      while (Date.now() < deadline && pid === 0) {
        try {
          pid = Number((await readFile(pidFile, 'utf8')).trim())
        } catch {
          await sleep(20)
        }
      }
      expect(pid).toBeGreaterThan(0)
      expect(isAlive(pid)).toBe(true)

      req.destroy()

      const deadDeadline = Date.now() + 3_000
      while (Date.now() < deadDeadline && isAlive(pid)) await sleep(20)
      expect(isAlive(pid)).toBe(false)
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
      await rm(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
