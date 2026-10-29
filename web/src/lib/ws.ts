import type { ClientMessage, ServerMessage, ClientMessageType } from '@shared/protocol.js'
import { isServerMessage } from '@shared/protocol.js'
import { generateUUID } from './uuid.js'
import { appUrl } from './basePath.js'

export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting'
type MessageHandler = (message: ServerMessage) => void
type StatusHandler = (status: ConnectionStatus) => void

export const WS_CLIENT_PING_INTERVAL_MS = 25_000
export const WS_CLIENT_PONG_TIMEOUT_MS = 10_000
export const WS_HEARTBEAT_TIMEOUT_CLOSE_CODE = 4002

export class WebSocketClient {
  private ws: WebSocket | null = null
  private handlers = new Set<MessageHandler>()
  private statusHandler: StatusHandler | null = null
  private baseUrl: string
  private isReconnecting = false
  private connectingPromise: Promise<void> | null = null
  private lastCloseCode: number = 0
  private reconnectAttempts: number = 0
  private manualReconnectScheduled = false // User triggered reconnect pending
  private pwaRecoveryAttempted = false
  private intentionalClose = false
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private pendingPingId: string | null = null

  constructor(url: string) {
    this.baseUrl = url
  }

  private getUrl(): string {
    const token = localStorage.getItem('openfox_token')
    if (token) {
      const separator = this.baseUrl.includes('?') ? '&' : '?'
      return `${this.baseUrl}${separator}token=${encodeURIComponent(token)}`
    }
    return this.baseUrl
  }

  setToken(token: string): void {
    localStorage.setItem('openfox_token', token)
  }

  clearToken(): void {
    localStorage.removeItem('openfox_token')
  }

  hasToken(): boolean {
    return !!localStorage.getItem('openfox_token')
  }

  getLastCloseCode(): number {
    return this.lastCloseCode
  }

  onStatusChange(handler: StatusHandler): void {
    this.statusHandler = handler
  }

  connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve()
    }

    this.lastCloseCode = 0
    this.isReconnecting = false

    if (this.connectingPromise && this.ws?.readyState === WebSocket.CONNECTING) {
      return this.connectingPromise
    }

    this.lastCloseCode = 0
    this.isReconnecting = false

    if (this.connectingPromise && this.ws?.readyState === WebSocket.CONNECTING) {
      console.warn('[WS CLIENT] Connection already in progress, returning existing promise')
      return this.connectingPromise
    }

    this.intentionalClose = false
    this.connectingPromise = new Promise((resolve, reject) => {
      try {
        const url = this.getUrl()
        this.ws = new WebSocket(url)

        const timeout = setTimeout(() => {
          if (this.ws?.readyState === WebSocket.CONNECTING) {
            this.ws.close()
            reject(new Error('Connection timeout'))
          }
        }, 5000)

        this.ws.onopen = () => {
          clearTimeout(timeout)
          this.isReconnecting = false
          this.reconnectAttempts = 0
          this.connectingPromise = null
          this.statusHandler?.('connected')
          resolve()
          this.startHeartbeat()
        }

        this.ws.onclose = (event) => {
          clearTimeout(timeout)
          this.stopHeartbeat()
          this.lastCloseCode = event.code
          if (this.ws?.readyState === WebSocket.CONNECTING) {
            this.connectingPromise = null
            this.statusHandler?.('disconnected')
            reject(new Error(`Connection closed: ${event.code}`))
          } else {
            this.connectingPromise = null
            this.statusHandler?.('disconnected')
            this.attemptReconnect()
          }
        }

        this.ws.onerror = (error) => {
          clearTimeout(timeout)
          console.error('WebSocket error:', error)
          this.connectingPromise = null
          reject(error)
        }

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            if (isServerMessage(data)) {
              if (data.type === 'pong') {
                if (data.id === this.pendingPingId) {
                  if (this.pongTimer !== null) {
                    clearTimeout(this.pongTimer)
                  }
                  this.pongTimer = null
                  this.pendingPingId = null
                }
                return
              }
              this.handlers.forEach((handler) => handler(data))
            }
          } catch (error) {
            console.error('Failed to parse WebSocket message:', error)
          }
        }
      } catch (error) {
        this.connectingPromise = null
        reject(error)
      }
    })

    return this.connectingPromise
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.pingTimer = setInterval(() => {
      if (this.pendingPingId !== null) {
        return
      }

      const id = generateUUID()
      this.pendingPingId = id
      try {
        this.ws?.send(JSON.stringify({ id, type: 'ping', payload: {} }))
      } catch {
        this.handleHeartbeatTimeout()
        return
      }
      this.pongTimer = setTimeout(() => this.handleHeartbeatTimeout(), WS_CLIENT_PONG_TIMEOUT_MS)
    }, WS_CLIENT_PING_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
    }
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer)
    }
    this.pingTimer = null
    this.pongTimer = null
    this.pendingPingId = null
  }

  private handleHeartbeatTimeout(): void {
    this.stopHeartbeat()
    const socket = this.ws
    this.ws = null
    if (socket) {
      socket.onopen = null
      socket.onclose = null
      socket.onerror = null
      socket.onmessage = null
    }
    try {
      socket?.close(WS_HEARTBEAT_TIMEOUT_CLOSE_CODE, 'heartbeat timeout')
    } catch {
      this.ws = null
    }
    this.lastCloseCode = WS_HEARTBEAT_TIMEOUT_CLOSE_CODE
    this.connectingPromise = null
    console.warn('[WS] No pong within timeout — reconnecting')
    this.statusHandler?.('disconnected')
    this.attemptReconnect()
  }

  private async recoverPwaStuckConnection(): Promise<void> {
    if (this.pwaRecoveryAttempted) return
    const isPwa = window.matchMedia('(display-mode: standalone)').matches
    if (!isPwa || !('serviceWorker' in navigator)) return

    this.pwaRecoveryAttempted = true
    const registrations = await navigator.serviceWorker.getRegistrations()
    if (registrations.length === 0) return

    console.warn('[WS] PWA mode detected with stale service worker — unregistering and reloading')
    await Promise.all(registrations.map((r) => r.unregister()))
    window.location.reload()
  }

  private attemptReconnect(): void {
    // A user-initiated disconnect must never be overridden by auto-reconnect.
    if (this.intentionalClose) return

    const isAuthFailure = this.lastCloseCode === 4000

    // Only auto-reconnect if NO token - with token, expect user to manually reconnect
    if (isAuthFailure && this.hasToken()) {
      console.warn('[WS] Auth failure or initial failure with token - not auto-reconnecting, awaiting user action')
      return
    }

    if (this.isReconnecting || this.manualReconnectScheduled) return
    this.isReconnecting = true
    this.statusHandler?.('reconnecting')

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts || 0), 30000)
    this.reconnectAttempts = (this.reconnectAttempts || 0) + 1

    setTimeout(() => {
      this.isReconnecting = false
      this.manualReconnectScheduled = false
      this.connect().catch(() => {
        // After several failed attempts, try PWA recovery
        if (this.reconnectAttempts >= 3) {
          this.recoverPwaStuckConnection()
        }
      })
    }, delay)
  }

  reconnect(): void {
    this.manualReconnectScheduled = true
    this.isReconnecting = false
    this.lastCloseCode = 0
    this.connectingPromise = null
    this.connect().catch(() => {
      this.recoverPwaStuckConnection()
    })
  }

  disconnect(): void {
    this.stopHeartbeat()
    this.isReconnecting = false
    this.reconnectAttempts = 0
    this.intentionalClose = true
    if (this.ws) {
      const socket = this.ws
      this.ws = null
      // Detach handlers so a delayed close() completion (real browsers fire
      // onclose asynchronously) cannot schedule an auto-reconnect or race a
      // freshly-created socket from a subsequent connect().
      socket.onopen = null
      socket.onclose = null
      socket.onerror = null
      socket.onmessage = null
      socket.close()
    }
    this.connectingPromise = null
  }

  resetReconnectAttempts(): void {
    this.reconnectAttempts = 0
  }

  send<T>(type: ClientMessageType, payload: T): string {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected')
    }

    const id = generateUUID()
    const message: ClientMessage<T> = { id, type, payload }
    this.ws.send(JSON.stringify(message))
    return id
  }

  subscribe(handler: MessageHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

// Singleton instance
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
let port = window.location.port
if (!port) {
  port =
    window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
      ? '10469'
      : window.location.protocol === 'https:'
        ? '443'
        : '80'
}
const wsUrl = `${protocol}//${window.location.hostname}:${port}${appUrl('/ws')}`
export const wsClient = new WebSocketClient(wsUrl)
