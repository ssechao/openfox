import { describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { CommandAbortedError, runFile } from './bounded-exec.js'
import { requestAbortSignal } from './request-abort.js'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('requestAbortSignal', () => {
  it('kills the in-flight subprocess when the HTTP client disconnects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openfox-req-abort-'))
    const pidFile = join(dir, 'child.pid')
    const script = [
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'setInterval(()=>{},1000)',
    ].join('')

    const server = http.createServer((req, res) => {
      const signal = requestAbortSignal(req, res)
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
