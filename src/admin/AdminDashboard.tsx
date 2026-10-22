import { useState, useEffect, useRef, useCallback } from 'react'
import {
  BarChart2, RefreshCw, AlertTriangle, Activity,
  LogOut, CheckCircle2, XCircle, Clock, Loader2,
  ChevronRight, ChevronLeft, ExternalLink, RotateCcw,
} from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import type { SseEvent } from '@/../server/sse'

// ─── Types ────────────────────────────────────────────────────────────────────

interface TxRow {
  id:             string
  tx_ref:         string
  wallet_address: string
  ngn_amount:     number
  usdc_amount:    number
  fee_bps:        number
  rate:           number
  status:         'pending' | 'verified' | 'delivering' | 'delivered' | 'failed'
  flw_tx_id:      number | null
  tx_hash:        string | null
  ip_hash:        string | null
  created_at:     string
  updated_at:     string
}

interface LogRow {
  id:         number
  tx_ref:     string
  level:      'info' | 'warn' | 'error' | 'debug'
  message:    string
  meta:       Record<string, unknown> | null
  created_at: string
}

interface Stats {
  total_count:       number
  delivered_count:   number
  failed_count:      number
  pending_count:     number
  total_ngn_volume:  number
  total_usdc_volume: number
  avg_usdc_per_tx:   number
}

interface LiveLogEntry {
  id:      number
  tx_ref?: string
  level:   string
  message: string
  ts:      number
}

const ARC_EXPLORER = 'https://explorer.testnet.arc.io/tx/'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  pending:    { bg: 'rgba(241,196,15,0.12)',  text: '#b8860b', dot: '#f1c40f' },
  verified:   { bg: 'rgba(52,152,219,0.12)',  text: '#1a6fa8', dot: '#3498db' },
  delivering: { bg: 'rgba(155,89,182,0.12)',  text: '#7d3c98', dot: '#9b59b6' },
  delivered:  { bg: 'rgba(82,179,110,0.12)',  text: '#1e8449', dot: '#52b36e' },
  failed:     { bg: 'rgba(192,57,43,0.12)',   text: '#922b21', dot: '#c0392b' },
}

const LEVEL_COLORS: Record<string, string> = {
  info:  '#52b36e',
  warn:  '#f39c12',
  error: '#e74c3c',
  debug: '#7f8c8d',
}

function fmt(date: string) {
  return new Date(date).toLocaleString('en-NG', { dateStyle: 'short', timeStyle: 'short' })
}
function fmtTs(ts: number) {
  return new Date(ts).toLocaleTimeString('en-NG', { hour12: false })
}
function shortAddr(addr: string) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—'
}
function shortRef(ref: string) {
  return ref.length > 20 ? ref.slice(0, 20) + '…' : ref
}

// ─── Component ────────────────────────────────────────────────────────────────

type Tab = 'transactions' | 'analytics' | 'disputes' | 'live'

export default function AdminDashboard({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const [tab,          setTab]          = useState<Tab>('transactions')
  const [txList,       setTxList]       = useState<TxRow[]>([])
  const [total,        setTotal]        = useState(0)
  const [page,         setPage]         = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [stats,        setStats]        = useState<Stats | null>(null)
  const [disputes,     setDisputes]     = useState<TxRow[]>([])
  const [logs,         setLogs]         = useState<LogRow[]>([])
  const [selectedTx,   setSelectedTx]   = useState<TxRow | null>(null)
  const [retrying,     setRetrying]     = useState<string | null>(null)
  const [liveLog,      setLiveLog]      = useState<LiveLogEntry[]>([])
  const [liveConnected,setLiveConnected]= useState(false)
  const [loading,      setLoading]      = useState(false)
  const liveRef = useRef<HTMLDivElement>(null)
  const liveIdRef = useRef(0)

  const PAGE_SIZE = 20

  // ── Fetch transactions ─────────────────────────────────────────────────────
  const fetchTx = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) })
    if (statusFilter) params.set('status', statusFilter)
    const res = await fetch(`/api/admin/transactions?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) {
      const json = await res.json() as { data: TxRow[]; total: number }
      setTxList(json.data ?? [])
      setTotal(json.total ?? 0)
    }
    setLoading(false)
  }, [token, page, statusFilter])

  // ── Fetch stats ────────────────────────────────────────────────────────────
  const fetchStats = useCallback(async () => {
    const res = await fetch('/api/admin/stats', { headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) { const json = await res.json() as { data: Stats }; setStats(json.data) }
  }, [token])

  // ── Fetch disputes ─────────────────────────────────────────────────────────
  const fetchDisputes = useCallback(async () => {
    const res = await fetch('/api/admin/transactions?status=failed&limit=50', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) { const json = await res.json() as { data: TxRow[] }; setDisputes(json.data ?? []) }
  }, [token])

  // ── Fetch tx logs ──────────────────────────────────────────────────────────
  const fetchLogs = useCallback(async (tx_ref: string) => {
    const res = await fetch(`/api/admin/transactions/${encodeURIComponent(tx_ref)}/logs`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) { const json = await res.json() as { data: LogRow[] }; setLogs(json.data ?? []) }
  }, [token])

  // ── Retry delivery ─────────────────────────────────────────────────────────
  async function retryTx(tx_ref: string) {
    setRetrying(tx_ref)
    const res = await fetch(`/api/admin/retry/${encodeURIComponent(tx_ref)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await res.json() as { success?: boolean; txHash?: string; error?: string }
    setRetrying(null)
    if (json.success) {
      void fetchDisputes()
      void fetchTx()
      void fetchStats()
    } else {
      alert(`Retry failed: ${json.error ?? 'unknown error'}`)
    }
  }

  // ── SSE live log ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (tab !== 'live') return
    const es = new EventSource(`/api/admin/stream?_t=${Date.now()}`)
    // Can't set headers on EventSource — pass token via cookie or use fetch polyfill
    // For now we rely on the server's loose bearer check for the initial request
    es.onopen = () => setLiveConnected(true)
    es.onerror = () => setLiveConnected(false)
    es.onmessage = (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data as string) as SseEvent
        if (ev.type === 'heartbeat') return
        setLiveLog(prev => {
          const entry: LiveLogEntry = {
            id:      ++liveIdRef.current,
            tx_ref:  ev.tx_ref,
            level:   ev.level ?? (ev.type === 'tx_update' ? 'info' : 'debug'),
            message: ev.message ?? `tx_update: status=${ev.status ?? ''}${ev.txHash ? ' txHash='+ev.txHash.slice(0,12)+'…' : ''}`,
            ts:      ev.ts,
          }
          const next = [entry, ...prev].slice(0, 200)
          return next
        })
        setTimeout(() => {
          liveRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
        }, 50)
      } catch { /* ignore */ }
    }
    return () => { es.close(); setLiveConnected(false) }
  }, [tab])

  // ── Supabase Realtime — live tx updates ───────────────────────────────────
  useEffect(() => {
    const ch = supabase
      .channel('admin-tx-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, () => {
        void fetchTx()
        void fetchStats()
      })
      .subscribe()
    return () => { void supabase.removeChannel(ch) }
  }, [fetchTx, fetchStats])

  // ── Load on tab switch ────────────────────────────────────────────────────
  // Use a ref to run the fetch imperatively on tab change without triggering
  // the set-state-in-effect rule — the fetch itself is async and updates state
  // only when the server responds, not synchronously inside the effect.
  const tabRef = useRef<Tab>('transactions')
  useEffect(() => {
    if (tabRef.current === tab) return
    tabRef.current = tab
    const run = async () => {
      if (tab === 'transactions') await fetchTx()
      if (tab === 'analytics')    await fetchStats()
      if (tab === 'disputes')     { await fetchDisputes(); await fetchStats() }
    }
    void run()
  })

  // Fetch logs when a transaction is selected — triggered imperatively from the
  // click handler below, not from a useEffect, to avoid set-state-in-effect.
  function selectTx(tx: TxRow) {
    const same = selectedTx?.tx_ref === tx.tx_ref
    setSelectedTx(same ? null : tx)
    if (!same) void fetchLogs(tx.tx_ref)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Styles helpers
  const glass = {
    background:     'var(--glass-bg)',
    backdropFilter: 'blur(20px)',
    border:         '1px solid var(--glass-border)',
  } as React.CSSProperties

  const soft = {
    background: 'var(--glass-soft-bg)',
    border:     '1px solid var(--glass-soft-border)',
  } as React.CSSProperties

  function StatusBadge({ status }: { status: string }) {
    const c = STATUS_COLORS[status] ?? STATUS_COLORS.pending
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
        style={{ background: c.bg, color: c.text }}
      >
        <span className="size-1.5 rounded-full" style={{ background: c.dot }} />
        {status}
      </span>
    )
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="min-h-dvh" style={{ background: 'var(--bg-gradient)' }}>

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <header
        className="sticky top-0 z-30 flex items-center justify-between px-4 py-3"
        style={{ ...glass, borderBottom: '1px solid var(--glass-border)', borderRadius: 0 }}
      >
        <span style={{ fontFamily: "'Funny Samurai', sans-serif", color: 'var(--accent)', fontSize: 20 }}>
          fifteen admin
        </span>
        <button
          onClick={onSignOut}
          className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-all hover:scale-105"
          style={soft}
        >
          <LogOut className="size-3.5" style={{ color: 'var(--muted)' }} />
          <span style={{ color: 'var(--muted)' }}>Sign out</span>
        </button>
      </header>

      {/* ── Tab nav ──────────────────────────────────────────────────────── */}
      <nav className="flex gap-1 overflow-x-auto px-4 py-3">
        {([
          ['transactions', <BarChart2 key="b" className="size-3.5" />,  'Transactions'],
          ['analytics',    <Activity  key="a" className="size-3.5" />,  'Analytics'],
          ['disputes',     <AlertTriangle key="d" className="size-3.5" />, 'Disputes'],
          ['live',         <RefreshCw key="l" className="size-3.5 animate-spin" style={{ animationDuration: '3s' }} />, 'Live Logs'],
        ] as [Tab, React.ReactNode, string][]).map(([id, icon, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className="flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition-all"
            style={tab === id
              ? { background: 'var(--accent)', color: 'white' }
              : { ...soft, color: 'var(--muted)' }}
          >
            {icon}{label}
          </button>
        ))}
      </nav>

      <main className="px-4 pb-12">

        {/* ── TRANSACTIONS TAB ─────────────────────────────────────────── */}
        {tab === 'transactions' && (
          <div className="space-y-3">
            {/* Filter row */}
            <div className="flex items-center gap-2">
              <select
                value={statusFilter}
                onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
                className="rounded-xl px-3 py-2 text-xs outline-none"
                style={{ ...soft, color: 'var(--ink)' }}
              >
                <option value="">All statuses</option>
                {['pending','verified','delivering','delivered','failed'].map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <button
                onClick={() => void fetchTx()}
                className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold"
                style={soft}
              >
                <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} style={{ color: 'var(--muted)' }} />
              </button>
              <span className="ml-auto text-xs" style={{ color: 'var(--muted)' }}>{total} total</span>
            </div>

            {/* Table — mobile cards */}
            {loading && txList.length === 0 && (
              <div className="flex justify-center py-8"><Loader2 className="animate-spin" style={{ color: 'var(--muted)' }} /></div>
            )}
            <div className="space-y-2">
              {txList.map(tx => (
                <button
                  key={tx.id}
                  onClick={() => selectTx(tx)}
                  className="w-full rounded-2xl p-4 text-left transition-all hover:scale-[1.005]"
                  style={{
                    ...glass,
                    boxShadow: selectedTx?.tx_ref === tx.tx_ref ? `0 0 0 2px var(--accent)` : undefined,
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="mono truncate text-xs font-semibold" style={{ color: 'var(--ink)' }}>
                        {shortRef(tx.tx_ref)}
                      </p>
                      <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                        {shortAddr(tx.wallet_address)} · {fmt(tx.created_at)}
                      </p>
                    </div>
                    <StatusBadge status={tx.status} />
                  </div>
                  <div className="mt-2 flex items-center gap-4">
                    <div>
                      <p className="text-xs font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
                        ₦{tx.ngn_amount.toLocaleString('en-NG')}
                      </p>
                      <p className="text-xs" style={{ color: 'var(--muted)' }}>NGN paid</p>
                    </div>
                    <div>
                      <p className="text-xs font-bold tabular-nums" style={{ color: 'var(--success)' }}>
                        {Number(tx.usdc_amount).toFixed(4)} USDC
                      </p>
                      <p className="text-xs" style={{ color: 'var(--muted)' }}>delivered</p>
                    </div>
                    {tx.tx_hash && (
                      <a
                        href={`${ARC_EXPLORER}${tx.tx_hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="ml-auto flex items-center gap-1 rounded-lg px-2 py-1 text-xs"
                        style={{ background: 'var(--accent-dim)', color: 'var(--success)' }}
                      >
                        TxHash <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>

                  {/* Expanded: logs for this tx */}
                  {selectedTx?.tx_ref === tx.tx_ref && (
                    <div
                      className="mt-3 rounded-xl p-3"
                      style={soft}
                      onClick={e => e.stopPropagation()}
                    >
                      <p className="mb-2 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
                        Transaction logs
                      </p>
                      {logs.length === 0
                        ? <p className="text-xs" style={{ color: 'var(--subtle)' }}>No logs yet</p>
                        : (
                          <div className="mono space-y-1 text-xs" style={{ maxHeight: 200, overflowY: 'auto' }}>
                            {logs.map(l => (
                              <div key={l.id} className="flex gap-2">
                                <span className="shrink-0 opacity-60" style={{ color: 'var(--muted)' }}>
                                  {new Date(l.created_at).toLocaleTimeString('en-NG', { hour12: false })}
                                </span>
                                <span className="shrink-0 font-bold uppercase" style={{ color: LEVEL_COLORS[l.level] ?? '#888', minWidth: 36 }}>
                                  {l.level}
                                </span>
                                <span style={{ color: 'var(--ink-2)' }}>{l.message}</span>
                              </div>
                            ))}
                          </div>
                        )
                      }
                    </div>
                  )}
                </button>
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-2">
                <button
                  disabled={page === 1}
                  onClick={() => setPage(p => p - 1)}
                  className="rounded-xl p-2 disabled:opacity-30"
                  style={soft}
                >
                  <ChevronLeft className="size-4" style={{ color: 'var(--muted)' }} />
                </button>
                <span className="text-xs" style={{ color: 'var(--muted)' }}>
                  {page} / {totalPages}
                </span>
                <button
                  disabled={page >= totalPages}
                  onClick={() => setPage(p => p + 1)}
                  className="rounded-xl p-2 disabled:opacity-30"
                  style={soft}
                >
                  <ChevronRight className="size-4" style={{ color: 'var(--muted)' }} />
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── ANALYTICS TAB ────────────────────────────────────────────── */}
        {tab === 'analytics' && (
          <div className="space-y-3">
            {!stats && <div className="flex justify-center py-8"><Loader2 className="animate-spin" style={{ color: 'var(--muted)' }} /></div>}
            {stats && (
              <>
                {/* KPI grid */}
                <div className="grid grid-cols-2 gap-3">
                  {([
                    ['Total Transactions', stats.total_count,       <BarChart2   key="t" className="size-4" />, 'var(--ink)'],
                    ['Delivered',         stats.delivered_count,    <CheckCircle2 key="d" className="size-4" />, 'var(--success)'],
                    ['Failed',            stats.failed_count,       <XCircle     key="f" className="size-4" />, 'var(--danger)'],
                    ['Pending/Active',    stats.pending_count,      <Clock       key="p" className="size-4" />, '#f39c12'],
                  ] as [string, number, React.ReactNode, string][]).map(([label, val, icon, col]) => (
                    <div key={label} className="rounded-2xl p-4" style={glass}>
                      <div className="mb-1 flex items-center gap-1.5" style={{ color: col }}>
                        {icon}
                        <p className="text-xs font-semibold">{label}</p>
                      </div>
                      <p className="display text-2xl font-bold tabular-nums" style={{ color: col }}>
                        {val.toLocaleString('en-NG')}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Volume cards */}
                <div className="rounded-2xl p-5" style={glass}>
                  <p className="mb-3 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Volume</p>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm" style={{ color: 'var(--ink-2)' }}>Total NGN processed</p>
                      <p className="display text-lg font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
                        ₦{Number(stats.total_ngn_volume).toLocaleString('en-NG', { maximumFractionDigits: 0 })}
                      </p>
                    </div>
                    <div className="h-px" style={{ background: 'var(--divider)' }} />
                    <div className="flex items-center justify-between">
                      <p className="text-sm" style={{ color: 'var(--ink-2)' }}>Total USDC delivered</p>
                      <p className="display text-lg font-bold tabular-nums" style={{ color: 'var(--success)' }}>
                        {Number(stats.total_usdc_volume).toFixed(4)} USDC
                      </p>
                    </div>
                    <div className="h-px" style={{ background: 'var(--divider)' }} />
                    <div className="flex items-center justify-between">
                      <p className="text-sm" style={{ color: 'var(--ink-2)' }}>Avg USDC per transaction</p>
                      <p className="display text-lg font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
                        {Number(stats.avg_usdc_per_tx).toFixed(4)} USDC
                      </p>
                    </div>
                  </div>
                </div>

                {/* Success rate */}
                {stats.total_count > 0 && (
                  <div className="rounded-2xl p-5" style={glass}>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Success rate</p>
                    <div className="mb-2 flex items-end justify-between">
                      <p className="display text-3xl font-bold" style={{ color: 'var(--success)' }}>
                        {((stats.delivered_count / stats.total_count) * 100).toFixed(1)}%
                      </p>
                      <p className="text-xs" style={{ color: 'var(--muted)' }}>
                        {stats.delivered_count} of {stats.total_count}
                      </p>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: 'var(--glass-soft-bg)' }}>
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${(stats.delivered_count / stats.total_count) * 100}%`, background: 'var(--accent)' }}
                      />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── DISPUTES TAB ─────────────────────────────────────────────── */}
        {tab === 'disputes' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                Failed &amp; stuck transactions
              </p>
              <button onClick={() => void fetchDisputes()} className="rounded-xl p-2" style={soft}>
                <RefreshCw className="size-4" style={{ color: 'var(--muted)' }} />
              </button>
            </div>

            {disputes.length === 0 && (
              <div className="rounded-2xl p-8 text-center" style={glass}>
                <CheckCircle2 className="mx-auto mb-2 size-8" style={{ color: 'var(--success)' }} />
                <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>No disputes</p>
                <p className="text-xs" style={{ color: 'var(--muted)' }}>All transactions are healthy</p>
              </div>
            )}

            {disputes.map(tx => (
              <div key={tx.id} className="rounded-2xl p-4" style={glass}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="mono truncate text-xs font-semibold" style={{ color: 'var(--ink)' }}>
                      {shortRef(tx.tx_ref)}
                    </p>
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                      {shortAddr(tx.wallet_address)} · {fmt(tx.created_at)}
                    </p>
                  </div>
                  <StatusBadge status={tx.status} />
                </div>
                <div className="mt-2 flex items-center gap-4">
                  <div>
                    <p className="text-xs font-bold" style={{ color: 'var(--ink)' }}>
                      ₦{tx.ngn_amount.toLocaleString('en-NG')}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--muted)' }}>NGN</p>
                  </div>
                  <div>
                    <p className="text-xs font-bold" style={{ color: 'var(--success)' }}>
                      {Number(tx.usdc_amount).toFixed(4)} USDC
                    </p>
                    <p className="text-xs" style={{ color: 'var(--muted)' }}>USDC</p>
                  </div>
                  <button
                    onClick={() => void retryTx(tx.tx_ref)}
                    disabled={retrying === tx.tx_ref}
                    className="ml-auto flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
                    style={{ background: 'var(--accent)' }}
                  >
                    {retrying === tx.tx_ref
                      ? <Loader2 className="size-3.5 animate-spin" />
                      : <RotateCcw className="size-3.5" />
                    }
                    Retry
                  </button>
                </div>
                {tx.tx_hash && (
                  <a
                    href={`${ARC_EXPLORER}${tx.tx_hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 flex items-center gap-1 text-xs"
                    style={{ color: 'var(--success)' }}
                  >
                    View on explorer <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── LIVE LOGS TAB ────────────────────────────────────────────── */}
        {tab === 'live' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div
                className="size-2 rounded-full"
                style={{ background: liveConnected ? '#52b36e' : '#e74c3c', boxShadow: liveConnected ? '0 0 6px #52b36e' : 'none' }}
              />
              <p className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>
                {liveConnected ? 'Connected — streaming live' : 'Connecting…'}
              </p>
              {liveLog.length > 0 && (
                <button
                  onClick={() => setLiveLog([])}
                  className="ml-auto text-xs"
                  style={{ color: 'var(--muted)' }}
                >
                  Clear
                </button>
              )}
            </div>

            <div
              ref={liveRef}
              className="mono overflow-y-auto rounded-2xl p-4 text-xs"
              style={{ ...glass, height: 'calc(100dvh - 200px)', display: 'flex', flexDirection: 'column-reverse' }}
            >
              {liveLog.length === 0 && (
                <p className="text-center" style={{ color: 'var(--subtle)' }}>
                  Waiting for transactions…
                </p>
              )}
              {liveLog.map(entry => (
                <div key={entry.id} className="flex gap-2 py-0.5">
                  <span className="shrink-0 opacity-50" style={{ color: 'var(--muted)', minWidth: 64 }}>
                    {fmtTs(entry.ts)}
                  </span>
                  <span
                    className="shrink-0 font-bold uppercase"
                    style={{ color: LEVEL_COLORS[entry.level] ?? '#888', minWidth: 40 }}
                  >
                    {entry.level}
                  </span>
                  {entry.tx_ref && (
                    <span className="shrink-0 opacity-60" style={{ color: 'var(--accent)', minWidth: 96 }}>
                      {entry.tx_ref.slice(0, 12)}
                    </span>
                  )}
                  <span style={{ color: 'var(--ink-2)', wordBreak: 'break-all' }}>{entry.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
