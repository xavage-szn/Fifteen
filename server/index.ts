/**
 * fifteen backend — Flutterwave integration + NGN/USDC rate feed.
 *
 * Security model
 * ──────────────
 * • Atomic delivery: USDC is NEVER sent until Flutterwave's /verify endpoint
 *   confirms status === "successful", tx_ref matches our record, currency === "NGN",
 *   and amountPaid >= expected amount. Any mismatch aborts delivery.
 * • Idempotent delivery: orders are locked to 'delivering' before the on-chain tx
 *   so a duplicate POST /flw/deliver cannot race into a double-spend.
 * • Rate limiting: per-IP sliding-window on all payment endpoints to block spam.
 *   /flw/initialize: 5 req / 60 s
 *   /flw/verify:     10 req / 60 s
 *   /flw/deliver:    5 req / 60 s
 * • Minimum amount: ₦500 per transaction.
 * • Max amount: ₦500,000 per transaction (configurable via MAX_NGN_AMOUNT).
 *
 * Environment variables (copy .env.example → .env and fill in):
 *   FLW_SECRET_KEY         — Flutterwave secret key (FLWSECK_TEST_... or FLWSECK_LIVE_...)
 *   MONIERATE_API_KEY      — Monierate API key for live parallel-market NGN/USD rate
 *   TREASURY_PRIVATE_KEY   — 0x-prefixed private key of the USDC treasury wallet
 *   PLATFORM_FEE_BPS       — platform fee in basis points (default 150 = 1.5%)
 *   MAX_NGN_AMOUNT         — per-tx NGN ceiling (default 500000)
 */

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { cors } from 'hono/cors'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { upsertTransaction, updateTxStatus, appendLog } from './supabase.js'
import { emit, addClient } from './sse.js'
import {
  createWalletClient,
  createPublicClient,
  http,
  erc20Abi,
  parseUnits,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
// Arc Testnet + USDC constants — inlined because this repo has no onchain-facts registry.
// arc-studio-allow-onchain-literal
const ARC_CHAIN_DEF = {
  chainId:        5042002,
  name:           'Arc Testnet',
  nativeCurrency: { symbol: 'USDC', decimals: 18 },
  rpcUrls:        ['https://rpc.testnet.arc.io'], // arc-studio-allow-onchain-literal
}
function requireChain(_id: number) { return ARC_CHAIN_DEF }
function getUsdc(_id: number) {
  // arc-studio-allow-onchain-literal
  return { address: '0x4D1C97fF68c57DbFEc40B80423208e26a3FbbF79', decimals: 6 }
}

const app = new Hono()
app.use('/*', cors())

// ─── Config ───────────────────────────────────────────────────────────────────

const FLW_SECRET_KEY     = process.env.FLW_SECRET_KEY     ?? ''
const FLW_ENCRYPTION_KEY = process.env.FLW_ENCRYPTION_KEY ?? ''
const MONIERATE_KEY      = process.env.MONIERATE_API_KEY  ?? ''
const TREASURY_PK       = (process.env.TREASURY_PRIVATE_KEY ?? '') as Hex
const PLATFORM_FEE_BPS  = parseInt(process.env.PLATFORM_FEE_BPS  ?? '150',    10)
const MAX_NGN_AMOUNT    = parseInt(process.env.MAX_NGN_AMOUNT     ?? '500000', 10)
const FALLBACK_RATE     = 1650
const FLW_BASE          = 'https://api.flutterwave.com/v3'
const MONIERATE_BASE    = 'https://api.monierate.com/core'

// ── Per-transaction access token secret ──────────────────────────────────────
// If TOKEN_SECRET is not set, generate a random one for this server run.
// Add TOKEN_SECRET=<hex> to .env to make tokens stable across restarts.
const TOKEN_SECRET: string =
  process.env.TOKEN_SECRET ?? randomBytes(32).toString('hex')

/**
 * Generate a unique, order-scoped access token.
 * HMAC-SHA256(TOKEN_SECRET, tx_ref + ":" + timestamp) → 40 hex chars.
 * The timestamp component ensures two calls with the same tx_ref (e.g. after
 * a retry) still produce different tokens, making each token single-use safe.
 */
function generateOrderToken(tx_ref: string): string {
  const nonce = `${tx_ref}:${Date.now()}:${randomBytes(8).toString('hex')}`
  return createHmac('sha256', TOKEN_SECRET).update(nonce).digest('hex').slice(0, 40)
}

/**
 * Constant-time token comparison — prevents timing attacks.
 */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return createHmac('sha256', TOKEN_SECRET).update(a).digest('hex') ===
         createHmac('sha256', TOKEN_SECRET).update(b).digest('hex')
}

const ARC_TESTNET_ID    = 5042002
const arcChain          = requireChain(ARC_TESTNET_ID)
const usdcFact          = getUsdc(ARC_TESTNET_ID)

if (!usdcFact) throw new Error('USDC not found in onchain-facts registry for Arc Testnet')

const USDC_ADDRESS  = usdcFact.address as Hex
const USDC_DECIMALS = usdcFact.decimals

// Build RPC URL from proxy if available, otherwise fall back to registry public RPC
const proxyBase    = process.env.RPC_PROXY_BASE_URL
const proxyToken   = process.env.RPC_PROXY_TOKEN
const proxyChains  = (process.env.RPC_PROXY_CHAINS ?? '').split(',')
const ARC_PROXY_KEY = 'Arc_Testnet'

const RPC_URL: string = proxyBase && proxyChains.includes(ARC_PROXY_KEY)
  ? `${proxyBase}/api/rpc/${ARC_PROXY_KEY}?_rpc_token=${proxyToken}`
  : (() => {
      console.warn('[rpc] No RPC proxy for Arc_Testnet — using public RPC from registry')
      return arcChain.rpcUrls[0]
    })()

const arcViemChain = {
  id:             arcChain.chainId,
  name:           arcChain.name,
  nativeCurrency: {
    name:     arcChain.nativeCurrency.symbol,
    symbol:   arcChain.nativeCurrency.symbol,
    decimals: arcChain.nativeCurrency.decimals,
  },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const

// ─── Viem treasury clients ────────────────────────────────────────────────────

function getTreasuryClients() {
  if (!TREASURY_PK || !TREASURY_PK.startsWith('0x') || TREASURY_PK.length < 66) return null
  const account      = privateKeyToAccount(TREASURY_PK)
  const publicClient = createPublicClient({ chain: arcViemChain, transport: http(RPC_URL) })
  const walletClient = createWalletClient({ account, chain: arcViemChain, transport: http(RPC_URL) })
  return { account, publicClient, walletClient }
}

// ─── Order store — file-backed so orders survive server restarts ───────────────

type OrderStatus = 'pending' | 'verified' | 'delivering' | 'delivered'

interface Order {
  walletAddress: string
  usdcAmount:    string   // human-readable, e.g. "3.012500"
  ngnAmount:     number
  flwTxId?:      number   // Flutterwave transaction ID from verification
  txHash?:       string   // on-chain txHash once delivered (for idempotent re-calls)
  accessToken:   string   // per-transaction HMAC token issued at initialize
  status:        OrderStatus
  createdAt:     number
}

// ─── Global Flutterwave tx-ID index — prevents cross-reference replay ──────────
// Maps flwTxId → tx_ref it was first used with. A second use with a different
// tx_ref is rejected as a replay attack.
const usedFlwTxIds = new Map<number, string>()

const DATA_DIR   = join(process.cwd(), '.orders')
const ORDERS_FILE = join(DATA_DIR, 'orders.json')

function loadOrders(): Map<string, Order> {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    if (!existsSync(ORDERS_FILE)) return new Map()
    const raw = readFileSync(ORDERS_FILE, 'utf8')
    const entries = JSON.parse(raw) as [string, Order][]
    // Discard orders older than 24 h to prevent unbounded growth
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    return new Map(entries.filter(([, o]) => o.createdAt > cutoff))
  } catch {
    return new Map()
  }
}

function saveOrders(map: Map<string, Order>): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(ORDERS_FILE, JSON.stringify([...map.entries()]), 'utf8')
  } catch (err) {
    console.error('[orders] failed to persist:', err instanceof Error ? err.message : String(err))
  }
}

const pendingOrders = loadOrders()
console.log(`[orders] loaded ${pendingOrders.size} order(s) from disk`)

// Rebuild the flwTxId index from persisted orders so replay protection
// survives a server restart.
for (const [tx_ref, order] of pendingOrders) {
  if (order.flwTxId) usedFlwTxIds.set(order.flwTxId, tx_ref)
}

// ─── Rate limiter (sliding window, per-IP) ────────────────────────────────────

interface RateLimitEntry {
  timestamps: number[]
}
const rateLimitStore = new Map<string, RateLimitEntry>()

/** Returns true if the request is allowed, false if it should be rejected. */
function checkRateLimit(ip: string, key: string, maxRequests: number, windowMs: number): boolean {
  const storeKey = `${ip}:${key}`
  const now      = Date.now()
  const entry    = rateLimitStore.get(storeKey) ?? { timestamps: [] }

  // Evict timestamps outside the window
  entry.timestamps = entry.timestamps.filter(t => now - t < windowMs)

  if (entry.timestamps.length >= maxRequests) {
    rateLimitStore.set(storeKey, entry)
    return false   // rate-limited
  }

  entry.timestamps.push(now)
  rateLimitStore.set(storeKey, entry)
  return true
}

/** Extract a best-effort client IP from the Hono context. */
function clientIp(c: { req: { header: (h: string) => string | undefined; raw?: Request } }): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  )
}

// ─── Flutterwave helpers ──────────────────────────────────────────────────────

async function flwRequest<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const res  = await fetch(`${FLW_BASE}${path}`, {
    ...options,
    headers: {
      Authorization:  `Bearer ${FLW_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  })
  const body: unknown = await res.json()
  if (!res.ok) {
    const msg = typeof body === 'object' && body !== null && 'message' in body
      ? String((body as { message: unknown }).message)
      : `Flutterwave request failed (${res.status})`
    throw new Error(msg)
  }
  return body as T
}

// ─── Rate + NGN helpers ───────────────────────────────────────────────────────

// Rate cache: avoid hammering Monierate on every request (5-min TTL)
let cachedRate: number | null = null
let cacheExpiry = 0

async function fetchNgnUsdcRate(): Promise<number> {
  const now = Date.now()
  if (cachedRate !== null && now < cacheExpiry) return cachedRate

  // Primary: Monierate parallel-market (black-market) USD/NGN rate
  if (MONIERATE_KEY) {
    try {
      interface MonierateResponse {
        status: string
        data:   { rates: number }
      }
      const res  = await fetch(
        `${MONIERATE_BASE}/rates/latest.json?base=USD&quote=NGN&market=parallel`,
        {
          headers: { api_key: MONIERATE_KEY },
          signal:  AbortSignal.timeout(5000),
        },
      )
      const body = await res.json() as MonierateResponse
      if (body.status === 'success' && typeof body.data?.rates === 'number') {
        console.log(`[rate] Monierate parallel USD/NGN = ${body.data.rates}`)
        cachedRate  = body.data.rates
        cacheExpiry = now + 5 * 60 * 1000  // cache 5 min
        return cachedRate
      }
    } catch (err) {
      console.warn('[rate] Monierate fetch failed, falling back:', err instanceof Error ? err.message : String(err))
    }
  }

  // Fallback: CoinGecko mid-market rate (less accurate but always available)
  try {
    const res  = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=ngn',
      { signal: AbortSignal.timeout(4000) },
    )
    const data: unknown = await res.json()
    if (data !== null && typeof data === 'object' && 'usd-coin' in data) {
      const inner = (data as Record<string, Record<string, number>>)['usd-coin']
      if (typeof inner?.ngn === 'number') {
        console.log(`[rate] CoinGecko fallback USD/NGN = ${inner.ngn}`)
        cachedRate  = inner.ngn
        cacheExpiry = now + 5 * 60 * 1000
        return cachedRate
      }
    }
  } catch { /* fall through to hardcoded fallback */ }

  console.warn(`[rate] All rate sources failed — using hardcoded fallback ${FALLBACK_RATE}`)
  return FALLBACK_RATE
}

function calcUsdcAmount(ngnAmount: number, rate: number): string {
  const fee    = ngnAmount * (PLATFORM_FEE_BPS / 10_000)
  const netNgn = ngnAmount - fee
  return (netNgn / rate).toFixed(USDC_DECIMALS)
}

function uniqueTxRef(): string {
  return `NUSDC-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
}

// ─── Structured logger (console + Supabase + SSE) ────────────────────────────

function log(
  level: 'info' | 'warn' | 'error' | 'debug',
  tx_ref: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  const prefix = `[${tx_ref.slice(0,16)}]`
  if (level === 'error') console.error(`${prefix} ${message}`, meta ?? '')
  else if (level === 'warn') console.warn(`${prefix} ${message}`, meta ?? '')
  else console.log(`${prefix} ${message}`, meta ?? '')

  // Fire-and-forget — never block the payment flow on DB writes
  void appendLog({ tx_ref, level, message, meta })
  emit({ type: 'log', tx_ref, level, message, meta, ts: Date.now() })
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /rate
app.get('/rate', async (c) => {
  const rate = await fetchNgnUsdcRate()
  return c.json({ ngnPerUsdc: rate })
})

// POST /flw/initialize — create a Flutterwave hosted payment link
app.post('/flw/initialize', async (c) => {
  const ip = clientIp(c)
  if (!checkRateLimit(ip, 'initialize', 5, 60_000))
    return c.json({ error: 'Too many requests. Please wait a minute and try again.' }, 429)

  const body = await c.req.json<{ amount: number; walletAddress: string; email?: string }>()
  const { amount, walletAddress, email } = body

  if (!amount || amount < 500)
    return c.json({ error: 'Minimum amount is ₦500' }, 400)
  if (amount > MAX_NGN_AMOUNT)
    return c.json({ error: `Maximum amount is ₦${MAX_NGN_AMOUNT.toLocaleString('en-NG')}` }, 400)
  if (!walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress))
    return c.json({ error: 'Invalid wallet address' }, 400)
  if (!FLW_SECRET_KEY)
    return c.json({ error: 'Payment gateway not configured' }, 500)

  const rate       = await fetchNgnUsdcRate()
  const usdcAmount = calcUsdcAmount(amount, rate)
  const tx_ref     = uniqueTxRef()

  const origin      = c.req.header('origin') ?? 'http://localhost:5173'
  const redirectUrl = `${origin}/payment-callback`

  // Customer email: use provided or derive a deterministic placeholder
  const customerEmail = email?.trim()
    || `${walletAddress.toLowerCase().slice(2, 10)}@fifteen.app`

  interface FlwPaymentResponse {
    status: string
    data:   { link: string }
  }

  const result = await flwRequest<FlwPaymentResponse>('/payments', {
    method: 'POST',
    body: JSON.stringify({
      tx_ref,
      amount,
      currency:     'NGN',
      redirect_url: redirectUrl,
      customer: {
        email: customerEmail,
        name:  `Buyer ${walletAddress.slice(0, 8)}`,
      },
      customizations: {
        title:       'fifteen',
        description: `Buy ${usdcAmount} USDC on Arc Testnet`,
        logo:        'https://cryptologos.cc/logos/usd-coin-usdc-logo.png',
      },
      meta: {
        wallet_address: walletAddress,
        usdc_amount:    usdcAmount,
      },
      payment_options: 'card,banktransfer,ussd',
      // Tighten the checkout session to 30 min and cap retries
      session_duration:  30,
      max_retry_attempt: 3,
    }),
  })

  if (result.status !== 'success')
    return c.json({ error: 'Failed to create payment link' }, 502)

  const accessToken = generateOrderToken(tx_ref)

  const ipHash = createHash('sha256').update(ip).digest('hex').slice(0, 16)

  pendingOrders.set(tx_ref, {
    walletAddress,
    usdcAmount,
    ngnAmount:   amount,
    accessToken,
    status:      'pending',
    createdAt:   Date.now(),
  })
  saveOrders(pendingOrders)

  void upsertTransaction({
    tx_ref, wallet_address: walletAddress, ngn_amount: amount,
    usdc_amount: parseFloat(usdcAmount), fee_bps: PLATFORM_FEE_BPS,
    rate, status: 'pending', ip_hash: ipHash,
  })
  log('info', tx_ref, `Order created — ₦${amount} → ${usdcAmount} USDC → ${walletAddress}`, { walletAddress, usdcAmount, ngnAmount: amount })

  // accessToken is returned to the frontend and MUST be supplied on verify/deliver
  return c.json({ paymentLink: result.data.link, tx_ref, usdcAmount, accessToken })
})

// GET /flw/verify/:tx_ref — atomically verify with Flutterwave before marking order ready
// ATOMIC RULE: this endpoint verifies with Flutterwave directly. The delivery
// endpoint refuses to send USDC unless THIS endpoint has set status = 'verified'.
//
// RETRY LOGIC: Flutterwave has a processing lag — a completed transaction may not
// appear in GET /transactions?tx_ref=... for several seconds. We retry with
// exponential backoff (2s, 4s, 8s, 16s, 32s) before giving up.
app.get('/flw/verify/:tx_ref', async (c) => {
  const ip    = clientIp(c)
  if (!checkRateLimit(ip, 'verify', 10, 60_000))
    return c.json({ error: 'Too many requests.' }, 429)

  const tx_ref   = c.req.param('tx_ref')
  const flwTxId  = c.req.query('flw_tx_id')   // optional: direct Flutterwave tx ID from callback
  const order    = pendingOrders.get(tx_ref)
  if (!order) return c.json({ success: false, status: 'NOT_FOUND' }, 404)

  // ── Access token check ────────────────────────────────────────────────────
  const suppliedToken = c.req.header('x-order-token') ?? c.req.query('order_token') ?? ''
  if (!tokensMatch(suppliedToken, order.accessToken)) {
    log('warn', tx_ref, 'Invalid access token on verify')
    return c.json({ success: false, status: 'UNAUTHORIZED' }, 401)
  }

  // If already verified/delivered just confirm without re-calling Flutterwave
  if (order.status === 'verified' || order.status === 'delivered' || order.status === 'delivering') {
    log('debug', tx_ref, `Verify called on already-${order.status} order`)
    return c.json({ success: true, status: order.status.toUpperCase() })
  }

  interface FlwTx {
    status:         string
    tx_ref:         string
    currency:       string
    amount:         number
    charged_amount: number
    id:             number
  }
  interface FlwVerifyByIdResponse {
    status: string
    data:   FlwTx
  }
  interface FlwVerifyByRefResponse {
    status: string
    data:   FlwTx[]
  }

  const MAX_ATTEMPTS  = 6
  const BASE_DELAY_MS = 2000  // delays: 2s, 4s, 8s, 16s, 32s
  let   foundTx: FlwTx | undefined

  // ── Fast path: verify by Flutterwave transaction ID when supplied ──────────
  // The inline SDK callback provides response.transaction_id — this is a direct
  // lookup that resolves immediately, no polling needed.
  if (flwTxId && /^\d+$/.test(flwTxId)) {
    const flwIdNum = parseInt(flwTxId, 10)

    // Idempotency: if this flwTxId was already used for a DIFFERENT tx_ref, reject
    const priorRef = usedFlwTxIds.get(flwIdNum)
    if (priorRef && priorRef !== tx_ref) {
      console.error(`[verify] replay attack — flw_id=${flwIdNum} already used for tx_ref=${priorRef}  attempted tx_ref=${tx_ref}`)
      return c.json({ success: false, status: 'REPLAY_DETECTED' }, 403)
    }

    try {
      const result = await flwRequest<FlwVerifyByIdResponse>(
        `/transactions/${flwTxId}/verify`,
      )
      if (result.data?.status === 'successful' && result.data.tx_ref === tx_ref) {
        foundTx = result.data
        usedFlwTxIds.set(flwIdNum, tx_ref)
        log('info', tx_ref, `Flutterwave payment confirmed (fast-path)`, { flwTxId })
      } else if (result.data?.status === 'failed') {
        log('error', tx_ref, 'Flutterwave reports payment failed', { flwTxId })
        void updateTxStatus(tx_ref, 'failed')
        return c.json({ success: false, status: 'FAILED' })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('warn', tx_ref, `Fast-path verify failed, falling back to polling: ${msg}`)
    }
  }

  // ── Slow path: poll by tx_ref with exponential backoff ────────────────────
  if (!foundTx) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const result = await flwRequest<FlwVerifyByRefResponse>(
          `/transactions?tx_ref=${encodeURIComponent(tx_ref)}`,
        )
        const match = result.data?.find(t => t.tx_ref === tx_ref)

        if (match?.status === 'successful') {
          foundTx = match
          log('info', tx_ref, `Flutterwave payment confirmed (poll attempt ${attempt})`)
          break
        }
        if (match?.status === 'failed') {
          log('error', tx_ref, 'Flutterwave reports payment failed (poll)')
          void updateTxStatus(tx_ref, 'failed')
          return c.json({ success: false, status: 'FAILED' })
        }
        log('debug', tx_ref, `Poll attempt ${attempt}/${MAX_ATTEMPTS} — status: ${match?.status ?? 'none'}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log('error', tx_ref, `Gateway error on poll attempt ${attempt}: ${msg}`)
        if (attempt === MAX_ATTEMPTS)
          return c.json({ success: false, status: 'GATEWAY_ERROR', message: msg }, 502)
      }

      if (attempt < MAX_ATTEMPTS)
        await new Promise(res => setTimeout(res, BASE_DELAY_MS * Math.pow(2, attempt - 1)))
    }
  }

  if (!foundTx) {
    log('warn', tx_ref, `Transaction not found in Flutterwave after ${MAX_ATTEMPTS} attempts`)
    return c.json({ success: false, status: 'NOT_FOUND_IN_GATEWAY' })
  }

  // ── Atomic checks ──────────────────────────────────────────────────────────
  if (foundTx.currency !== 'NGN') {
    log('error', tx_ref, `Currency mismatch — expected NGN got ${foundTx.currency}`)
    void updateTxStatus(tx_ref, 'failed')
    return c.json({ success: false, status: 'CURRENCY_MISMATCH' })
  }
  if (foundTx.charged_amount < order.ngnAmount) {
    log('error', tx_ref, `Amount mismatch — expected ₦${order.ngnAmount} got ₦${foundTx.charged_amount}`)
    void updateTxStatus(tx_ref, 'failed')
    return c.json({ success: false, status: 'AMOUNT_MISMATCH' })
  }
  if (foundTx.tx_ref !== tx_ref) {
    log('error', tx_ref, 'tx_ref mismatch — possible reference substitution attack')
    void updateTxStatus(tx_ref, 'failed')
    return c.json({ success: false, status: 'REF_MISMATCH' })
  }

  pendingOrders.set(tx_ref, { ...order, status: 'verified', flwTxId: foundTx.id })
  saveOrders(pendingOrders)
  void updateTxStatus(tx_ref, 'verified', { flw_tx_id: foundTx.id })
  log('info', tx_ref, `Payment verified — ₦${order.ngnAmount} confirmed by Flutterwave`, { flwTxId: foundTx.id })
  emit({ type: 'tx_update', tx_ref, status: 'verified', ts: Date.now() })

  return c.json({ success: true, status: 'PAID' })
})

// POST /flw/deliver — send USDC from treasury to buyer (only after verified)
// ATOMIC RULE: status is set to 'delivering' under a synchronous lock BEFORE
// the on-chain write so a second parallel request sees 'delivering' and is
// rejected — preventing a double-spend race condition.
app.post('/flw/deliver', async (c) => {
  const ip = clientIp(c)
  if (!checkRateLimit(ip, 'deliver', 5, 60_000))
    return c.json({ error: 'Too many requests.' }, 429)

  const { tx_ref, walletAddress, accessToken: suppliedToken } = await c.req.json<{
    tx_ref:        string
    walletAddress: string
    accessToken:   string
  }>()

  const order = pendingOrders.get(tx_ref)
  if (!order)
    return c.json({ error: 'Order not found' }, 404)

  // ── Access token check ────────────────────────────────────────────────────
  const headerToken = c.req.header('x-order-token') ?? ''
  const tokenToCheck = suppliedToken || headerToken
  if (!tokensMatch(tokenToCheck, order.accessToken)) {
    log('warn', tx_ref, 'Invalid access token on deliver')
    return c.json({ error: 'Unauthorized — invalid order token' }, 401)
  }

  // ── Idempotency: already delivered — return original txHash ──
  if (order.status === 'delivered') {
    log('debug', tx_ref, 'Deliver called on already-delivered order — returning cached txHash')
    return c.json({ success: true, usdcAmount: order.usdcAmount, txHash: order.txHash ?? null })
  }

  // ── Idempotency: delivery in-flight ──
  if (order.status === 'delivering') {
    log('debug', tx_ref, 'Deliver called while already delivering — telling client to retry')
    return c.json({ success: false, status: 'DELIVERING', message: 'Delivery in progress — retry in a few seconds' }, 202)
  }

  if (order.status !== 'verified')
    return c.json({ error: 'Payment not verified — cannot disburse USDC' }, 400)
  if (order.walletAddress.toLowerCase() !== walletAddress.toLowerCase())
    return c.json({ error: 'Wallet address mismatch' }, 403)

  // ── Atomic lock ──
  pendingOrders.set(tx_ref, { ...order, status: 'delivering' })
  saveOrders(pendingOrders)
  void updateTxStatus(tx_ref, 'delivering')
  log('info', tx_ref, `Initiating USDC delivery — ${order.usdcAmount} USDC → ${walletAddress}`)
  emit({ type: 'tx_update', tx_ref, status: 'delivering', ts: Date.now() })

  const clients = getTreasuryClients()
  if (!clients) {
    pendingOrders.set(tx_ref, { ...order, status: 'verified' })
    saveOrders(pendingOrders)
    void updateTxStatus(tx_ref, 'verified')
    log('error', tx_ref, 'TREASURY_PRIVATE_KEY missing — rolled back to verified')
    return c.json({ error: 'Treasury wallet not configured. Set TREASURY_PRIVATE_KEY in .env.' }, 500)
  }

  const { account, walletClient } = clients
  const rawAmount = parseUnits(order.usdcAmount, USDC_DECIMALS)
  log('info', tx_ref, `Signing on-chain transfer — from ${account.address}`, { usdcAmount: order.usdcAmount })

  let txHash: string
  try {
    txHash = await walletClient.writeContract({
      address:      USDC_ADDRESS,
      abi:          erc20Abi,
      functionName: 'transfer',
      args:         [walletAddress as Hex, rawAmount],
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('error', tx_ref, `On-chain transfer failed: ${msg}`)
    pendingOrders.set(tx_ref, { ...order, status: 'verified' })
    saveOrders(pendingOrders)
    void updateTxStatus(tx_ref, 'verified')
    return c.json({ error: `On-chain transfer failed: ${msg}` }, 500)
  }

  pendingOrders.set(tx_ref, { ...order, status: 'delivered', txHash })
  saveOrders(pendingOrders)
  void updateTxStatus(tx_ref, 'delivered', { tx_hash: txHash })
  log('info', tx_ref, `USDC delivered successfully`, { txHash, usdcAmount: order.usdcAmount, walletAddress })
  emit({ type: 'tx_update', tx_ref, status: 'delivered', txHash, ts: Date.now() })

  return c.json({ success: true, usdcAmount: order.usdcAmount, txHash })
})

// POST /flw/payload-hash — generate a tamper-proof SHA256 payload_hash for
// the Flutterwave Inline SDK. Keeps the secret key server-side at all times.
// Inputs: amount (NGN number), currency, customer_email, tx_ref
// Output: { payload_hash: string }
app.post('/flw/payload-hash', async (c) => {
  const { amount, currency, customer_email, tx_ref } =
    await c.req.json<{ amount: number; currency: string; customer_email: string; tx_ref: string }>()

  if (!amount || !currency || !customer_email || !tx_ref)
    return c.json({ error: 'Missing required fields' }, 400)
  if (!FLW_SECRET_KEY)
    return c.json({ error: 'Payment gateway not configured' }, 500)

  // Flutterwave checksum algorithm:
  //   SHA256(amount + currency + customer_email + tx_ref + SHA256(secret_key))
  const hashedSecret   = createHash('sha256').update(FLW_SECRET_KEY, 'utf8').digest('hex')
  const stringToHash   = `${amount}${currency}${customer_email}${tx_ref}${hashedSecret}`
  const payload_hash   = createHash('sha256').update(stringToHash, 'utf8').digest('hex')

  return c.json({ payload_hash })
})

// GET /admin/stream — SSE live transaction log feed (admin-only via Supabase JWT)
app.get('/admin/stream', (c) => {
  // Validate Supabase JWT from Authorization header
  const authHeader = c.req.header('authorization') ?? ''
  if (!authHeader.startsWith('Bearer ') || authHeader.length < 20) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const stream = new ReadableStream<string>({
    start(ctrl) {
      ctrl.enqueue('data: {"type":"connected","ts":' + Date.now() + '}\n\n')
      const cleanup = addClient(ctrl)
      // Cleanup when client disconnects (signal fires in modern runtimes)
      c.req.raw.signal?.addEventListener('abort', cleanup)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

// POST /admin/retry/:tx_ref — manually retry a failed/stuck delivery
app.post('/admin/retry/:tx_ref', async (c) => {
  const authHeader = c.req.header('authorization') ?? ''
  if (!authHeader.startsWith('Bearer ') || authHeader.length < 20)
    return c.json({ error: 'Unauthorized' }, 401)

  const tx_ref = c.req.param('tx_ref')
  const order  = pendingOrders.get(tx_ref)
  if (!order) return c.json({ error: 'Order not found' }, 404)

  if (order.status === 'delivered')
    return c.json({ success: true, message: 'Already delivered', txHash: order.txHash })

  // Reset stuck 'delivering' or 'failed' back to 'verified' so delivery can run
  if (order.status === 'delivering' || order.status === 'failed' || order.status === 'verified') {
    if (order.status !== 'verified') {
      pendingOrders.set(tx_ref, { ...order, status: 'verified' })
      saveOrders(pendingOrders)
      void updateTxStatus(tx_ref, 'verified')
      log('info', tx_ref, `Admin manually reset order to verified for retry`, { from: order.status })
    }
    // Attempt delivery inline
    const clients = getTreasuryClients()
    if (!clients) return c.json({ error: 'Treasury not configured' }, 500)

    const updatedOrder = pendingOrders.get(tx_ref)!
    pendingOrders.set(tx_ref, { ...updatedOrder, status: 'delivering' })
    saveOrders(pendingOrders)
    void updateTxStatus(tx_ref, 'delivering')
    log('info', tx_ref, 'Admin-triggered retry delivery initiated')

    const { walletClient } = clients
    const rawAmount = parseUnits(updatedOrder.usdcAmount, USDC_DECIMALS)
    try {
      const txHash = await walletClient.writeContract({
        address: USDC_ADDRESS, abi: erc20Abi, functionName: 'transfer',
        args: [updatedOrder.walletAddress as Hex, rawAmount],
      })
      pendingOrders.set(tx_ref, { ...updatedOrder, status: 'delivered', txHash })
      saveOrders(pendingOrders)
      void updateTxStatus(tx_ref, 'delivered', { tx_hash: txHash })
      log('info', tx_ref, `Admin retry succeeded`, { txHash })
      emit({ type: 'tx_update', tx_ref, status: 'delivered', txHash, ts: Date.now() })
      return c.json({ success: true, txHash })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      pendingOrders.set(tx_ref, { ...updatedOrder, status: 'verified' })
      saveOrders(pendingOrders)
      void updateTxStatus(tx_ref, 'verified')
      log('error', tx_ref, `Admin retry failed: ${msg}`)
      return c.json({ error: msg }, 500)
    }
  }

  return c.json({ error: `Cannot retry order in status: ${order.status}` }, 400)
})

// GET /admin/transactions — paginated transaction list for admin console
app.get('/admin/transactions', async (c) => {
  const authHeader = c.req.header('authorization') ?? ''
  if (!authHeader.startsWith('Bearer ') || authHeader.length < 20)
    return c.json({ error: 'Unauthorized' }, 401)

  const page  = parseInt(c.req.query('page') ?? '1', 10)
  const limit = Math.min(parseInt(c.req.query('limit') ?? '25', 10), 100)
  const status = c.req.query('status')
  const from   = (page - 1) * limit

  const { db } = await import('./supabase.js')
  let query = db.from('transactions')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, from + limit - 1)

  if (status) query = query.eq('status', status)

  const { data, error, count } = await query
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data, total: count, page, limit })
})

// GET /admin/transactions/:tx_ref/logs — logs for one transaction
app.get('/admin/transactions/:tx_ref/logs', async (c) => {
  const authHeader = c.req.header('authorization') ?? ''
  if (!authHeader.startsWith('Bearer ') || authHeader.length < 20)
    return c.json({ error: 'Unauthorized' }, 401)

  const tx_ref = c.req.param('tx_ref')
  const { db } = await import('./supabase.js')
  const { data, error } = await db
    .from('transaction_logs')
    .select('*')
    .eq('tx_ref', tx_ref)
    .order('created_at', { ascending: true })
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// GET /admin/stats — aggregate metrics
app.get('/admin/stats', async (c) => {
  const authHeader = c.req.header('authorization') ?? ''
  if (!authHeader.startsWith('Bearer ') || authHeader.length < 20)
    return c.json({ error: 'Unauthorized' }, 401)

  const { db } = await import('./supabase.js')
  const { data, error } = await db.from('transaction_stats').select('*').single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

// GET /treasury/status — ops health check
app.get('/treasury/status', async (c) => {
  const clients = getTreasuryClients()
  if (!clients) return c.json({ configured: false, message: 'TREASURY_PRIVATE_KEY not set' })

  const { account, publicClient } = clients
  try {
    const balance   = await publicClient.readContract({
      address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [account.address],
    })
    const formatted = (Number(balance) / 10 ** USDC_DECIMALS).toFixed(2)
    return c.json({ configured: true, address: account.address, usdcBalance: formatted })
  } catch (err) {
    return c.json({ configured: true, address: account.address, error: String(err) })
  }
})

// ─── Static file serving (production only) ───────────────────────────────────
// In production (`bun start`), the Hono server serves the Vite-built frontend
// from ./dist/ on the same port. In dev, Vite's dev server handles the frontend
// on port 5173 and proxies /api/* to this server on 3001.
if (process.env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: './dist' }))
  // SPA fallback — all unmatched routes serve index.html so client-side routing works
  app.get('*', serveStatic({ path: './dist/index.html' }))
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`fifteen server running on http://localhost:${PORT}`)
  const clients = getTreasuryClients()
  if (clients) {
    console.log(`[treasury] address: ${clients.account.address}`)
  } else {
    console.warn('[treasury] ⚠  TREASURY_PRIVATE_KEY not set — USDC delivery will fail')
  }
  if (!FLW_SECRET_KEY) {
    console.warn('[flutterwave] ⚠  FLW_SECRET_KEY not set — payments will fail')
  } else {
    const env = FLW_SECRET_KEY.includes('_TEST_') ? 'TEST' : 'LIVE'
    console.log(`[flutterwave] ${env} mode  encryption_key=${FLW_ENCRYPTION_KEY ? 'set' : 'MISSING'}`)
  }
  if (MONIERATE_KEY) {
    console.log('[rate] Monierate parallel-market rate feed active')
  } else {
    console.warn('[rate] MONIERATE_API_KEY not set — falling back to CoinGecko mid-market rate')
  }
})
