/**
 * Supabase admin client for the fifteen backend.
 * Uses the service role key so it bypasses RLS and can write transactions/logs.
 * Never expose this client or the service role key to the browser.
 */
import { createClient } from '@supabase/supabase-js'

const url    = process.env.SUPABASE_URL          ?? ''
const secret = process.env.SUPABASE_SECRET_KEY   ?? ''

const hasSupabase = !!(url && secret)

if (!hasSupabase) {
  console.warn('[supabase] SUPABASE_URL or SUPABASE_SECRET_KEY not set — DB indexing disabled')
}

// Only instantiate the client when credentials are present — createClient throws
// on an empty URL even if you never call it.
export const db = hasSupabase
  ? createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })
  : (null as unknown as ReturnType<typeof createClient>)

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TxRecord {
  tx_ref:         string
  wallet_address: string
  ngn_amount:     number
  usdc_amount:    number
  fee_bps:        number
  rate:           number
  status:         'pending' | 'verified' | 'delivering' | 'delivered' | 'failed'
  flw_tx_id?:     number | null
  tx_hash?:       string | null
  ip_hash?:       string | null
  country?:       string | null
  lat?:           number | null
  lng?:           number | null
}

export interface LogRecord {
  tx_ref:  string
  level:   'info' | 'warn' | 'error' | 'debug'
  message: string
  meta?:   Record<string, unknown>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Upsert a transaction row. Logs full error details — never blocks payments. */
export async function upsertTransaction(rec: TxRecord): Promise<void> {
  if (!url || !secret) {
    console.warn('[supabase] upsertTransaction skipped — credentials missing')
    return
  }
  const { error } = await db.from('transactions').upsert(
    { ...rec, updated_at: new Date().toISOString() },
    { onConflict: 'tx_ref' },
  )
  if (error) {
    console.error('[supabase] upsert tx error:', error.message, '| code:', error.code, '| hint:', error.hint ?? '', '| details:', error.details ?? '')
  } else {
    console.log(`[supabase] upserted tx ${rec.tx_ref} status=${rec.status}`)
  }
}

/** Append a log line to transaction_logs. Logs full error details. */
export async function appendLog(rec: LogRecord): Promise<void> {
  if (!url || !secret) return
  const { error } = await db.from('transaction_logs').insert({
    tx_ref:  rec.tx_ref,
    level:   rec.level,
    message: rec.message,
    meta:    rec.meta ?? null,
  })
  if (error) {
    console.error('[supabase] insert log error:', error.message, '| code:', error.code, '| hint:', error.hint ?? '')
  }
}

/** Update just the status (+ optional fields) of a transaction. */
export async function updateTxStatus(
  tx_ref: string,
  status: TxRecord['status'],
  extra?: Partial<TxRecord>,
): Promise<void> {
  if (!url || !secret) return
  const { error } = await db
    .from('transactions')
    .update({ status, ...extra, updated_at: new Date().toISOString() })
    .eq('tx_ref', tx_ref)
  if (error) {
    console.error('[supabase] update status error:', error.message, '| code:', error.code, '| hint:', error.hint ?? '')
  } else {
    console.log(`[supabase] updated tx ${tx_ref} → ${status}`)
  }
}
