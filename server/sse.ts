/**
 * Server-Sent Events broadcaster for real-time transaction logs.
 * Any part of the server calls `emit(event)` and all connected admin
 * SSE clients receive it instantly.
 */

export interface SseEvent {
  type:    'log' | 'tx_update' | 'heartbeat'
  tx_ref?: string
  level?:  'info' | 'warn' | 'error' | 'debug'
  message?: string
  status?: string
  txHash?: string
  meta?:   Record<string, unknown>
  ts:      number
}

type SseController = ReadableStreamDefaultController<string>

const clients = new Set<SseController>()

/** Register a new SSE client controller. Returns cleanup fn. */
export function addClient(ctrl: SseController): () => void {
  clients.add(ctrl)
  return () => clients.delete(ctrl)
}

/** Broadcast an event to all connected SSE clients. */
export function emit(event: SseEvent): void {
  if (clients.size === 0) return
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const ctrl of clients) {
    try { ctrl.enqueue(payload) }
    catch { clients.delete(ctrl) }   // client disconnected
  }
}

// Heartbeat every 25 s to keep connections alive through proxies
setInterval(() => emit({ type: 'heartbeat', ts: Date.now() }), 25_000)
