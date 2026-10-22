import net from 'net'
import zlib from 'zlib'
import { promisify } from 'node:util'
import { logger } from '../utils/logger.js'

const gunzipAsync = promisify(zlib.gunzip)
const gzipAsync = promisify(zlib.gzip)
const inflateAsync = promisify(zlib.inflate)
const deflateAsync = promisify(zlib.deflate)
import type { SessionManager } from '../session/manager.js'
import { getProjectByWorkdir } from '../db/projects.js'

const OPENFOX_BASE_PORT = Number(process.env['OPENFOX_PORT'] ?? 10369)
const INJECT_SCRIPT = `<script src="http://127.0.0.1:${OPENFOX_BASE_PORT}/__inspect__.js"></script>`

function buildHttpHeaders(
  resHeaders: Record<string, string>,
  status: number,
  contentLengthOverride?: number,
  contentTypeOverride?: string,
): string {
  const newH: Record<string, string> = { ...resHeaders }
  delete newH['content-length']
  delete newH['transfer-encoding']
  newH['connection'] = 'close'
  if (contentLengthOverride !== undefined) newH['content-length'] = contentLengthOverride.toString()
  if (contentTypeOverride !== undefined) newH['content-type'] = contentTypeOverride
  return (
    `HTTP/1.1 ${status} OK\r\n` +
    Object.entries(newH)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n') +
    '\r\n\r\n'
  )
}

interface ProxyInstance {
  server: ReturnType<typeof net.createServer>
  target: string
}

const proxyPool = new Map<string, ProxyInstance>()
let nextOffset = 0

const PORT_SCAN_RANGE = 200

async function getAvailablePort(proxyBase: number): Promise<number> {
  // net.listen() beyond 65535 throws a synchronous RangeError that tryBind's
  // 'error' listener cannot catch, so keep the whole scan range below the
  // limit (the same bound findFreePort applies in manager.ts).
  const base = Math.min(proxyBase, 65535 - PORT_SCAN_RANGE)
  for (let port = base; port < base + PORT_SCAN_RANGE; port++) {
    if (await tryBind(port)) return port
  }
  return base + (nextOffset++ % PORT_SCAN_RANGE)
}

function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.on('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

function parseReqHeaders(str: string): { method: string; url: string; headers: Record<string, string> } {
  const lines = str.split('\r\n')
  const method = lines[0]!.split(' ')[0]!
  const url = lines[0]!.split(' ')[1]!
  const headers = parseHeaderLines(lines)
  return { method, url, headers }
}

function parseResHeaders(str: string): { status: number; headers: Record<string, string> } {
  const lines = str.split('\r\n')
  const status = parseInt(lines[0]!.split(' ')[1] || '200')
  const headers = parseHeaderLines(lines)
  return { status, headers }
}

function parseHeaderLines(lines: string[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) break
    const ci = line.indexOf(':')
    if (ci < 0) continue
    headers[line.slice(0, ci).toLowerCase()] = line.slice(ci + 1).trim()
  }
  return headers
}

function buildResponse(status: number, headers: Record<string, string>, body: Buffer) {
  const statusLine = `HTTP/1.1 ${status} ${status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Error'}`
  const headerLines = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n')
  const head = Buffer.from(`${statusLine}\r\n${headerLines}\r\n\r\n`, 'utf8')
  return Buffer.concat([head, body])
}

async function inflateBody(enc: string | null, buf: Buffer): Promise<Buffer> {
  if (enc === 'gzip') return gunzipAsync(buf)
  if (enc === 'deflate') return inflateAsync(buf)
  return buf
}

async function deflateBody(enc: string | null, buf: Buffer): Promise<Buffer> {
  if (enc === 'gzip') return gzipAsync(buf)
  if (enc === 'deflate') return deflateAsync(buf)
  return buf
}

async function injectScript(buf: Buffer): Promise<Buffer | null> {
  const bodyTag = Buffer.from('</body>')
  const headTag = Buffer.from('</head>')
  const inject = Buffer.from(INJECT_SCRIPT, 'utf8')
  let idx = buf.indexOf(bodyTag)
  if (idx < 0) idx = buf.indexOf(headTag)
  if (idx < 0) return null
  return Buffer.concat([buf.subarray(0, idx), inject, buf.subarray(idx)])
}

function dechunk(buf: Buffer): Buffer {
  const parts: Buffer[] = []
  let pos = 0
  while (pos < buf.length) {
    const nlIdx = buf.indexOf('\r\n', pos)
    if (nlIdx < 0) break
    const sizeStr = buf.subarray(pos, nlIdx).toString('ascii')
    const size = parseInt(sizeStr, 16)
    if (isNaN(size) || size < 0) break
    if (size === 0) break
    const chunkStart = nlIdx + 2
    const chunkEnd = chunkStart + size
    if (chunkEnd > buf.length) break
    parts.push(buf.subarray(chunkStart, chunkEnd))
    pos = chunkEnd + 2
  }
  return Buffer.concat(parts)
}

export async function startInspectProxy(
  target: string,
  sessionManager: SessionManager,
  devServerPort: number,
  workdir?: string,
): Promise<{ port: number; cleanup: () => void }> {
  // Place the proxy at devServerPort + 1000 to avoid colliding with the dev server's port range
  const port = await getAvailablePort(devServerPort + 1000)

  const server = net.createServer((client) => {
    let clientHead = ''
    let clientParsed = false
    let targetSocket: net.Socket | undefined

    client.on('data', (chunk) => {
      if (clientParsed) {
        targetSocket?.write(chunk)
        return
      }

      clientHead += chunk.toString('utf8')
      const he = clientHead.indexOf('\r\n\r\n')
      if (he < 0) return

      const { method, url, headers } = parseReqHeaders(clientHead)
      const isWS = headers['upgrade'] === 'websocket'
      clientParsed = true

      if (url === '/__openfox_sessions' && method === 'GET') {
        let sessions = sessionManager.listSessions()
        // Filter by project if workdir is known
        if (workdir) {
          const project = getProjectByWorkdir(workdir)
          if (project) {
            sessions = sessions.filter((s) => s.projectId === project.id)
          }
        }
        // Sort most recent first
        sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        const mapped = sessions.map((s) => ({
          id: s.id,
          title: s.title ?? s.id,
          createdAt: s.createdAt,
        }))
        client.write(
          buildResponse(200, { 'Content-Type': 'application/json' }, Buffer.from(JSON.stringify({ sessions: mapped }))),
        )
        client.end()
        return
      }

      if (url === '/__openfox_feedback' && method === 'POST') {
        const contentLength = parseInt(headers['content-length'] || '0', 10)
        let bodyData = chunk.slice(he + 4)
        let bodyTotal = bodyData.length
        const handleFeedback = () => {
          try {
            const { sessionId, element, annotation, pageUrl } = JSON.parse(bodyData.toString('utf8'))
            if (sessionId) {
              const elementDesc = element ? `${element.tag}${element.id ? '#' + element.id : ''}` : 'unknown'
              const htmlSnippet = element?.outerHTML ? `\nHtml: ${element.outerHTML.slice(0, 300)}` : ''
              const textSnippet = element?.textContent
                ? `\nText (SVG-stripped): ${element.textContent.slice(0, 500)}`
                : ''
              const content = `# User feedback from page inspection on dev_server\n\n## Context\n\nPage: ${pageUrl || ''}\nElement: ${elementDesc}\nxPath: ${element?.xpath || ''}${htmlSnippet}${textSnippet}\n\n## Feedback\n\n${annotation || '(none)'}`
              sessionManager.queueMessage(sessionId, 'asap', content, [], 'ui_feedback')
            }
            client.write(buildResponse(200, { 'Content-Type': 'application/json' }, Buffer.from('{"success":true}')))
          } catch {
            client.write(
              buildResponse(400, { 'Content-Type': 'application/json' }, Buffer.from('{"error":"Invalid request"}')),
            )
          }
          client.end()
        }
        if (bodyTotal >= contentLength) {
          handleFeedback()
          return
        }
        client.on('data', (more) => {
          bodyData = Buffer.concat([bodyData, more])
          bodyTotal += more.length
          if (bodyTotal < contentLength) return
          handleFeedback()
        })
        return
      }

      const targetParts = target.replace(/^https?:\/\//, '').split(':')
      const targetHost = targetParts[0] ?? '127.0.0.1'
      const targetPort = parseInt(targetParts[1] ?? '80')

      if (isWS) {
        targetSocket = net.connect(targetPort, targetHost)
        targetSocket.on('error', () => client.destroy())
        client.on('error', () => targetSocket!.destroy())
        targetSocket.write(clientHead)
        targetSocket.pipe(client)
        return
      }

      targetSocket = net.connect(targetPort, targetHost)
      targetSocket.on('error', () => {
        respondWithError(502, 'Bad Gateway')
      })
      client.on('error', () => targetSocket?.destroy())
      client.on('end', () => targetSocket!.end())

      // Force target to close connection after response so we get on('end') promptly
      const connClose = '\r\nConnection: close'
      const reqEnd = clientHead.indexOf('\r\n\r\n')
      const forwardHead = clientHead.slice(0, reqEnd) + connClose + clientHead.slice(reqEnd)
      targetSocket.write(forwardHead)
      let injecting = false
      targetSocket.on('close', () => {
        if (injecting) return
        if (!client.destroyed) client.end()
      })

      let serverHeadBuf = ''
      let serverParsed = false
      let isHtml = false
      let enc: string | null = null
      let status = 200
      let resHeaders: Record<string, string> = {}
      const bodyBuf: Buffer[] = []
      let headEnd = -1
      let responded = false

      function respondWithError(status: number, message: string) {
        if (responded) return
        responded = true
        client.write(buildResponse(status, { 'Content-Type': 'text/plain' }, Buffer.from(message)))
        client.end()
      }

      targetSocket.on('data', (sChunk) => {
        if (responded) return

        if (!serverParsed) {
          serverHeadBuf += sChunk.toString('utf8')
          const sHe = serverHeadBuf.indexOf('\r\n\r\n')
          if (sHe < 0) return
          headEnd = sHe + 4
          const p = parseResHeaders(serverHeadBuf.slice(0, sHe))
          status = p.status
          resHeaders = p.headers
          isHtml = (resHeaders['content-type'] || '').includes('text/html')
          enc = resHeaders['content-encoding'] || null
          const isChunked = (resHeaders['transfer-encoding'] || '').toLowerCase() === 'chunked'
          serverParsed = true

          if (isHtml && enc) {
            bodyBuf.push(sChunk.slice(headEnd))
            return
          }

          if (isHtml && isChunked) {
            bodyBuf.push(sChunk.slice(headEnd))
            return
          }

          if (isHtml) {
            bodyBuf.push(sChunk.slice(headEnd))
            return
          }

          client.write(sChunk)
          return
        }

        if (isHtml && enc) {
          bodyBuf.push(sChunk)
          return
        }
        if (isHtml) {
          bodyBuf.push(sChunk)
          return
        }
        client.write(sChunk)
      })

      targetSocket.on('end', () => {
        if (responded) return

        if (!serverParsed) {
          respondWithError(502, 'Upstream connection closed prematurely')
          return
        }

        if (isHtml && enc) {
          injecting = true
          void (async () => {
            if (responded) return
            const fullBody = Buffer.concat(bodyBuf)
            const isChunked = (resHeaders['transfer-encoding'] || '').toLowerCase() === 'chunked'
            const framed = isChunked ? dechunk(fullBody) : fullBody
            let decoded: Buffer
            try {
              decoded = await inflateBody(enc, framed)
            } catch {
              injecting = false
              client.end()
              return
            }

            const modified = await injectScript(decoded)
            if (!modified) {
              // No injection point found — send original body through (still compressed)
              const headStr = buildHttpHeaders(resHeaders, status)
              client.write(Buffer.from(headStr, 'utf8'))
              client.write(fullBody)
              injecting = false
              client.end()
              return
            }

            let compressed: Buffer
            try {
              compressed = await deflateBody(enc, modified)
            } catch {
              injecting = false
              client.end()
              return
            }

            const headStr = buildHttpHeaders(resHeaders, status, compressed.length)
            client.write(Buffer.from(headStr, 'utf8'))
            client.write(compressed)
            injecting = false
            client.end()
          })()
        } else if (isHtml && bodyBuf.length > 0) {
          const fullBody = Buffer.concat(bodyBuf)
          const isChunked = (resHeaders['transfer-encoding'] || '').toLowerCase() === 'chunked'
          const dechunks = isChunked ? dechunk(fullBody) : fullBody
          const bi = dechunks.indexOf('</body>')
          const hi = dechunks.indexOf('</head>')
          let modified: Buffer
          if (bi >= 0)
            modified = Buffer.concat([dechunks.slice(0, bi), Buffer.from(INJECT_SCRIPT, 'utf8'), dechunks.slice(bi)])
          else if (hi >= 0)
            modified = Buffer.concat([dechunks.slice(0, hi), Buffer.from(INJECT_SCRIPT, 'utf8'), dechunks.slice(hi)])
          else {
            // No injection point found — send original body through
            const headStr = buildHttpHeaders(
              resHeaders,
              status,
              Buffer.byteLength(dechunks),
              'text/html; charset=utf-8',
            )
            client.write(Buffer.from(headStr, 'utf8'))
            client.write(dechunks)
            client.end()
            return
          }

          const headStr = buildHttpHeaders(resHeaders, status, Buffer.byteLength(modified), 'text/html; charset=utf-8')
          client.write(Buffer.from(headStr, 'utf8'))
          client.write(modified)
          client.end()
        }
      })
    })

    client.on('error', () => {})
  })

  server.listen(port, '0.0.0.0', () => {
    logger.debug('Inspect proxy listening', { port, target })
  })

  proxyPool.set(target, { server, target })

  const cleanup = () => {
    server.close()
    proxyPool.delete(target)
    logger.debug('Inspect proxy stopped', { port, target })
  }

  return { port, cleanup }
}

export function stopAllInspectProxies(): void {
  for (const instance of proxyPool.values()) {
    instance.server.close()
  }
  proxyPool.clear()
}
