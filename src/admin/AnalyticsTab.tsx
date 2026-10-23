/**
 * Full analytics tab for the fifteen admin dashboard.
 * Charts: recharts (bar + donut + bounce). Globe: react-globe.gl (3-D WebGL).
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend,
} from 'recharts'
import Globe from 'react-globe.gl'
import {
  RefreshCw, TrendingUp, DollarSign, CheckCircle2, XCircle,
  Clock, Users, Eye, UserCheck,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface TimePoint {
  date:     string
  ngn:      number
  usdc:     number
  count:    number
  visitors: number
  traders:  number
}

interface BouncePoint {
  date:    string
  bounced: number
  traded:  number
  total:   number
}

interface CountryRow {
  country: string
  count:   number
  usdc:    number
}

interface GlobePoint {
  lat:     number
  lng:     number
  usdc:    number
  country: string
}

interface AnalyticsData {
  timeSeries:        TimePoint[]
  bounceSeries:      BouncePoint[]
  statusBreakdown:   Record<string, number>
  countryBreakdown:  CountryRow[]
  globePoints:       GlobePoint[]
  totalVisitors:     number
  bouncedVisitors:   number
  totalTraders:      number
  activeToday:       number
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

// ─── Constants ────────────────────────────────────────────────────────────────

const ACCENT       = '#5BA05C'
const STATUS_PALETTE: Record<string, string> = {
  delivered:  '#5BA05C',
  pending:    '#f1c40f',
  verified:   '#3498db',
  delivering: '#9b59b6',
  failed:     '#e74c3c',
}
const COUNTRY_COLORS = ['#5BA05C','#3498db','#9b59b6','#f39c12','#e74c3c','#1abc9c','#e67e22','#16a085','#8e44ad','#2980b9']

function fmt(n: number, prefix = '') {
  return prefix + n.toLocaleString('en-NG', { maximumFractionDigits: 2 })
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KPI({ label, value, sub, icon, color }: {
  label: string; value: string; sub?: string; icon: React.ReactNode; color: string
}) {
  const glass: React.CSSProperties = {
    background: 'var(--glass-bg)', backdropFilter: 'blur(20px)', border: '1px solid var(--glass-border)',
  }
  return (
    <div className="rounded-xl p-3" style={glass}>
      <div className="mb-1 flex items-center gap-1.5" style={{ color }}>
        {icon}
        <p className="text-xs font-semibold">{label}</p>
      </div>
      <p className="text-xl font-bold tabular-nums" style={{ color }}>{value}</p>
      {sub && <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>{sub}</p>}
    </div>
  )
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────

function BarTip({ active, payload, label }: {
  active?: boolean; payload?: { value: number; name: string }[]; label?: string
}) {
  if (!active || !payload?.length) return null
  const glass: React.CSSProperties = {
    background: 'var(--glass-bg)', backdropFilter: 'blur(20px)',
    border: '1px solid var(--glass-border)', borderRadius: 10, padding: '6px 10px', fontSize: 11,
  }
  return (
    <div style={glass}>
      <p className="mb-1 font-semibold" style={{ color: 'var(--ink)' }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: 'var(--ink-2)' }}>
          {p.name}: <strong>
            {p.name === 'NGN'
              ? '₦' + p.value.toLocaleString('en-NG', { maximumFractionDigits: 0 })
              : p.name === 'USDC'
              ? Number(p.value).toFixed(2) + ' USDC'
              : p.value}
          </strong>
        </p>
      ))}
    </div>
  )
}

// ─── Globe wrapper ────────────────────────────────────────────────────────────

function TradeGlobe({ points }: { points: GlobePoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState(280)

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 280
      setSize(Math.min(w, 420))
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  const gData = points.map(p => ({
    lat:   p.lat, lng: p.lng,
    size:  Math.log1p(p.usdc) * 0.008 + 0.01,
    color: ACCENT,
    label: `${p.country} — ${p.usdc.toFixed(2)} USDC`,
  }))

  return (
    <div ref={containerRef} className="w-full" style={{ height: size }}>
      <Globe
        width={size} height={size}
        backgroundColor="rgba(0,0,0,0)"
        globeImageUrl="//unpkg.com/three-globe/example/img/earth-night.jpg"
        pointsData={gData}
        pointLat="lat" pointLng="lng" pointColor="color" pointRadius="size"
        pointAltitude={0.01} pointLabel="label"
        atmosphereColor={ACCENT} atmosphereAltitude={0.15}
        enablePointerInteraction
      />
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AnalyticsTab({ token, stats }: { token: string; stats: Stats | null }) {
  const [data,    setData]    = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(false)

  const glass: React.CSSProperties = {
    background: 'var(--glass-bg)', backdropFilter: 'blur(20px)', border: '1px solid var(--glass-border)',
  }
  const soft: React.CSSProperties = {
    background: 'var(--glass-soft-bg)', border: '1px solid var(--glass-soft-border)',
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch('/api/admin/analytics', { headers: { Authorization: `Bearer ${token}` } })
      const json = res.ok ? await res.json() as AnalyticsData : null
      if (json) setData(json)
    } finally {
      setLoading(false)
    }
  }, [token])

  const loadRef = useRef(load)
  useEffect(() => { loadRef.current = load }, [load])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadRef.current() }, [])

  const donutData = data
    ? Object.entries(data.statusBreakdown).map(([name, value]) => ({ name, value }))
    : []

  const successRate = stats && stats.total_count > 0
    ? ((stats.delivered_count / stats.total_count) * 100).toFixed(1)
    : '—'

  const bounceRate = data && data.totalVisitors > 0
    ? ((data.bouncedVisitors / data.totalVisitors) * 100).toFixed(1)
    : '—'

  return (
    <div className="space-y-3 pb-6">

      {/* Header */}
      <div className="flex shrink-0 items-center justify-between">
        <p className="text-xs font-semibold" style={{ color: 'var(--ink)' }}>Analytics</p>
        <button onClick={() => void load()} className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs" style={soft}>
          <RefreshCw className={`size-3 ${loading ? 'animate-spin' : ''}`} style={{ color: 'var(--muted)' }} />
          Refresh
        </button>
      </div>

      {/* ── Visitor KPIs ── */}
      {data && (
        <div className="grid grid-cols-2 gap-2">
          <KPI
            label="Total Visitors"
            value={data.totalVisitors.toLocaleString()}
            sub="all site visits"
            icon={<Eye className="size-3.5" />}
            color="var(--ink)"
          />
          <KPI
            label="Active Today"
            value={data.activeToday.toLocaleString()}
            sub="unique wallets"
            icon={<TrendingUp className="size-3.5" />}
            color={ACCENT}
          />
          <KPI
            label="Total Traders"
            value={data.totalTraders.toLocaleString()}
            sub="completed trades"
            icon={<UserCheck className="size-3.5" />}
            color={ACCENT}
          />
          <KPI
            label="Bounced"
            value={`${bounceRate}%`}
            sub={`${data.bouncedVisitors} left without trading`}
            icon={<XCircle className="size-3.5" />}
            color="#e74c3c"
          />
        </div>
      )}

      {/* ── Transaction KPIs ── */}
      {stats && (
        <div className="grid grid-cols-2 gap-2">
          <KPI label="Total Orders"     value={stats.total_count.toLocaleString()}     icon={<TrendingUp   className="size-3.5" />} color="var(--ink)" />
          <KPI label="Delivered"        value={stats.delivered_count.toLocaleString()} icon={<CheckCircle2 className="size-3.5" />} color={ACCENT}     />
          <KPI label="Failed"           value={stats.failed_count.toLocaleString()}    icon={<XCircle      className="size-3.5" />} color="#e74c3c"    />
          <KPI label="Pending"          value={stats.pending_count.toLocaleString()}   icon={<Clock        className="size-3.5" />} color="#f1c40f"    />
          <KPI
            label="NGN Processed"
            value={'₦' + Number(stats.total_ngn_volume).toLocaleString('en-NG', { maximumFractionDigits: 0 })}
            icon={<DollarSign className="size-3.5" />} color="var(--ink)"
          />
          <KPI
            label="USDC Delivered"
            value={Number(stats.total_usdc_volume).toFixed(2)}
            sub="USDC"
            icon={<DollarSign className="size-3.5" />} color={ACCENT}
          />
        </div>
      )}

      {/* Success rate bar */}
      {stats && (
        <div className="rounded-xl p-3" style={glass}>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>Success rate</p>
            <p className="text-xs tabular-nums" style={{ color: 'var(--muted)' }}>
              {stats.delivered_count} / {stats.total_count}
            </p>
          </div>
          <p className="mb-2 text-2xl font-bold tabular-nums" style={{ color: ACCENT }}>{successRate}%</p>
          <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--glass-soft-bg)' }}>
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{ width: `${stats.total_count ? (stats.delivered_count / stats.total_count) * 100 : 0}%`, background: ACCENT }}
            />
          </div>
        </div>
      )}

      {/* Bounce chart — visitors who didn't trade */}
      {data && data.bounceSeries.length > 0 && (
        <div className="rounded-xl p-3" style={glass}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
            Visitors vs Traders (daily)
          </p>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={data.bounceSeries} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <XAxis
                dataKey="date"
                tick={{ fill: 'var(--muted)', fontSize: 10 }}
                tickFormatter={(d: string) => d.slice(5)}
                axisLine={false} tickLine={false}
              />
              <YAxis hide />
              <Tooltip content={<BarTip />} cursor={{ fill: 'rgba(91,160,92,0.07)' }} />
              <Bar dataKey="traded"  name="Traded"  radius={[3,3,0,0]} stackId="a" fill={ACCENT}    fillOpacity={0.85} />
              <Bar dataKey="bounced" name="Bounced" radius={[3,3,0,0]} stackId="a" fill="#e74c3c" fillOpacity={0.7}  />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Daily NGN volume */}
      {data && data.timeSeries.length > 0 && (
        <div className="rounded-xl p-3" style={glass}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Daily NGN Volume</p>
          <ResponsiveContainer width="100%" height={130}>
            <BarChart data={data.timeSeries} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <XAxis dataKey="date" tick={{ fill: 'var(--muted)', fontSize: 10 }} tickFormatter={(d: string) => d.slice(5)} axisLine={false} tickLine={false} />
              <YAxis hide />
              <Tooltip content={<BarTip />} cursor={{ fill: 'rgba(91,160,92,0.07)' }} />
              <Bar dataKey="ngn" name="NGN" radius={[3,3,0,0]}>
                {data.timeSeries.map((_, i) => <Cell key={i} fill={ACCENT} fillOpacity={0.85} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Daily USDC */}
      {data && data.timeSeries.length > 0 && (
        <div className="rounded-xl p-3" style={glass}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Daily USDC Delivered</p>
          <ResponsiveContainer width="100%" height={110}>
            <BarChart data={data.timeSeries} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <XAxis dataKey="date" tick={{ fill: 'var(--muted)', fontSize: 10 }} tickFormatter={(d: string) => d.slice(5)} axisLine={false} tickLine={false} />
              <YAxis hide />
              <Tooltip content={<BarTip />} cursor={{ fill: 'rgba(91,160,92,0.07)' }} />
              <Bar dataKey="usdc" name="USDC" radius={[3,3,0,0]}>
                {data.timeSeries.map((_, i) => <Cell key={i} fill="#3498db" fillOpacity={0.85} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Status donut */}
      {data && donutData.length > 0 && (
        <div className="rounded-xl p-3" style={glass}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Status Breakdown</p>
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie
                data={donutData} cx="50%" cy="50%"
                innerRadius="50%" outerRadius="70%"
                dataKey="value" paddingAngle={3}
                label={({ name, percent }: { name?: string; percent?: number }) =>
                  `${name ?? ''} ${((percent ?? 0) * 100).toFixed(0)}%`}
                labelLine={false}
              >
                {donutData.map((entry, i) => (
                  <Cell key={i} fill={STATUS_PALETTE[entry.name] ?? '#888'} />
                ))}
              </Pie>
              <Legend formatter={(value) => <span style={{ color: 'var(--ink-2)', fontSize: 11 }}>{value}</span>} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Country breakdown */}
      {data && data.countryBreakdown.length > 0 && (
        <div className="rounded-xl p-3" style={glass}>
          <div className="mb-2 flex items-center gap-1.5">
            <Users className="size-3.5" style={{ color: 'var(--muted)' }} />
            <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Top Countries</p>
          </div>
          <div className="space-y-2">
            {data.countryBreakdown.map((row, i) => {
              const maxCount = data.countryBreakdown[0]?.count ?? 1
              return (
                <div key={row.country}>
                  <div className="mb-0.5 flex items-center justify-between text-xs">
                    <span style={{ color: 'var(--ink-2)' }}>{row.country}</span>
                    <span className="tabular-nums font-semibold" style={{ color: 'var(--ink)' }}>
                      {row.count} · {fmt(row.usdc)} USDC
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--glass-soft-bg)' }}>
                    <div
                      className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${(row.count / maxCount) * 100}%`, background: COUNTRY_COLORS[i % COUNTRY_COLORS.length] }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 3D Globe */}
      <div className="rounded-xl p-3" style={glass}>
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
          Trade Origins — {data?.globePoints.length ?? 0} location{data?.globePoints.length !== 1 ? 's' : ''}
        </p>
        {data && data.globePoints.length > 0
          ? <TradeGlobe points={data.globePoints} />
          : (
            <p className="py-6 text-center text-xs" style={{ color: 'var(--muted)' }}>
              No geo data yet
            </p>
          )
        }
      </div>

      {/* Empty state */}
      {!loading && !data && (
        <div className="rounded-xl p-8 text-center" style={glass}>
          <p className="text-xs font-semibold" style={{ color: 'var(--ink)' }}>No analytics data</p>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>Appears once transactions are in the database</p>
        </div>
      )}
    </div>
  )
}
