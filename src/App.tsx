import { useState, useEffect } from 'react'
import { isAddress } from 'viem'
import { motion, AnimatePresence } from 'framer-motion'
import { ShoppingCart, Wallet, Loader2, ArrowDown, Sun, Moon } from 'lucide-react'
import { TokenUSDC } from '@web3icons/react'
import BuySheet from '@/components/BuySheet'
// Logo15market kept as fallback below
import { useUsdcBalance } from '@/hooks/useUsdcBalance'

const FALLBACK_RATE = 1650
const NGN_PRESETS   = [1_000, 2_500, 5_000, 10_000, 25_000]
const PLATFORM_FEE  = 0.015   // 1.5 %

function ngnToUsdc(ngn: number, rate: number) {
  return (ngn * (1 - PLATFORM_FEE)) / rate
}

// ── Dark-mode hook ─────────────────────────────────────────────────────────────
function useDarkMode(): [boolean, () => void] {
  const [dark, setDark] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    const saved = localStorage.getItem('15market-theme')
    if (saved) return saved === 'dark'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    const root = document.documentElement
    if (dark) { root.classList.add('dark') }
    else       { root.classList.remove('dark') }
    localStorage.setItem('15market-theme', dark ? 'dark' : 'light')
  }, [dark])

  return [dark, () => setDark(d => !d)]
}

export default function App() {
  const [buyOpen,     setBuyOpen]    = useState(false)
  const [usdcRate,    setUsdcRate]   = useState(FALLBACK_RATE)

  const [ngnInput,    setNgnInput]   = useState('')
  const [walletInput, setWalletInput]= useState('')
  const [dark, toggleDark]           = useDarkMode()

  const parsedNgn     = parseInt(ngnInput.replace(/,/g, ''), 10) || 0
  const hasAmount     = parsedNgn >= 500
  const usdcOut       = hasAmount ? ngnToUsdc(parsedNgn, usdcRate) : 0
  const addressValid  = isAddress(walletInput.trim())
  const walletAddress = addressValid ? (walletInput.trim() as `0x${string}`) : undefined
  const canBuy        = hasAmount && addressValid

  const { formatted: usdcBalance, isLoading: balanceLoad } = useUsdcBalance(walletAddress)

  useEffect(() => {
    fetch('/api/rate')
      .then(r => r.json() as Promise<{ ngnPerUsdc?: number }>)
      .then(d => { if (typeof d.ngnPerUsdc === 'number') setUsdcRate(d.ngnPerUsdc) })
      .catch(() => {})
  }, [])

  const handleNgnKey = (raw: string) => {
    const digits = raw.replace(/[^0-9]/g, '')
    setNgnInput(digits ? Number(digits).toLocaleString('en-NG') : '')
  }

  // Glass styles — same structure, now read from CSS vars so they flip with dark mode
  const glass = {
    card: {
      background:           'var(--glass-bg)',
      backdropFilter:       'blur(24px) saturate(180%)',
      WebkitBackdropFilter: 'blur(24px) saturate(180%)',
      border:               '1px solid var(--glass-border)',
      boxShadow:            dark
        ? '0 8px 32px rgba(0,0,0,0.30), inset 0 1px 0 rgba(82,179,110,0.08)'
        : '0 8px 32px rgba(15,45,28,0.07), inset 0 1px 0 rgba(255,255,255,0.55)',
    } as React.CSSProperties,
    soft: {
      background: 'var(--glass-soft-bg)',
      border:     '1px solid var(--glass-soft-border)',
    } as React.CSSProperties,
    pill: {
      background:           'var(--pill-bg)',
      backdropFilter:       'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      border:               '1px solid var(--pill-border)',
    } as React.CSSProperties,
  }

  return (
    <div className="relative min-h-dvh overflow-hidden" style={{ background: 'var(--bg-gradient)' }}>

      {/* Ambient blobs — only visible in light mode */}
      {!dark && (
        <div className="pointer-events-none fixed inset-0 overflow-hidden">
          <div style={{ position:'absolute', top:'4%', left:'2%', width:340, height:340, borderRadius:'50%', background:'radial-gradient(circle, rgba(82,179,110,0.12) 0%, transparent 70%)', filter:'blur(72px)' }} />
          <div style={{ position:'absolute', bottom:'8%', right:'4%', width:300, height:300, borderRadius:'50%', background:'radial-gradient(circle, rgba(82,179,110,0.08) 0%, transparent 70%)', filter:'blur(64px)' }} />
        </div>
      )}

      <div className="relative z-10 mx-auto max-w-md px-4 pb-12 pt-6">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <header className="mb-6 flex items-center justify-between">

          {/* Brand wordmark — Funny Samurai font from CDN */}
          <span style={{ fontFamily: "'Funny Samurai', sans-serif", fontSize: 21, color: 'var(--accent)', lineHeight: 1 }}>
            fifteen
          </span>

          {/* Right side: dark mode toggle only */}
          <div className="flex items-center gap-2">
            {/* Dark / light mode toggle */}
            <button
              onClick={toggleDark}
              aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
              className="flex size-8 items-center justify-center rounded-full transition-all hover:scale-105 active:scale-95"
              style={{
                background: 'var(--toggle-track)',
                border:     '1px solid var(--glass-border)',
              }}
            >
              {dark
                ? <Sun  className="size-4" style={{ color:'var(--accent)' }} />
                : <Moon className="size-4" style={{ color:'var(--muted)' }} />
              }
            </button>
          </div>
        </header>

        <main className="space-y-3">

          {/* ── 1. Buy widget card ───────────────────────────────────────── */}
          <div className="rounded-3xl p-5" style={glass.card}>

            {/* You Pay row */}
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-widest" style={{ color:'var(--muted)' }}>
              You Pay
            </p>
            <div className="rounded-2xl p-4" style={glass.soft}>
              <div className="flex items-baseline gap-2">
                <span className="display text-2xl font-bold" style={{ color:'var(--muted)' }}>₦</span>
                <input
                  inputMode="numeric"
                  value={ngnInput}
                  onChange={e => handleNgnKey(e.target.value)}
                  placeholder="0"
                  className="display w-full bg-transparent text-4xl font-bold tabular-nums outline-none placeholder:text-slate-400"
                  style={{ color:'var(--ink)' }}
                />
                <span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-bold" style={{ background:'var(--accent-dim)', color:'var(--ngn)' }}>NGN</span>
              </div>
              <p className="mt-1 text-xs" style={{ color:'var(--subtle)' }}>Min ₦500 · 1.5% fee included</p>
            </div>

            {/* Quick presets */}
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
              {NGN_PRESETS.map(p => (
                <button
                  key={p}
                  onClick={() => setNgnInput(p.toLocaleString('en-NG'))}
                  className="shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-all hover:scale-105 active:scale-95"
                  style={ngnInput === p.toLocaleString('en-NG')
                    ? { background:'var(--accent)', color:'white' }
                    : glass.pill}
                >
                  ₦{p.toLocaleString('en-NG')}
                </button>
              ))}
            </div>

            {/* Arrow divider */}
            <div className="my-3 flex items-center gap-3">
              <div className="h-px flex-1" style={{ background:'var(--divider)' }} />
              <div className="flex size-7 items-center justify-center rounded-full" style={{ background:'var(--arrow-bg)' }}>
                <ArrowDown className="size-3.5" style={{ color:'var(--muted)' }} />
              </div>
              <div className="h-px flex-1" style={{ background:'var(--divider)' }} />
            </div>

            {/* You Receive row */}
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-widest" style={{ color:'var(--muted)' }}>
              You Receive
            </p>
            <div className="rounded-2xl p-4" style={{ background:'var(--accent-dim)', border:'1px solid rgba(82,179,110,0.22)' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-baseline gap-2">
                  <span
                    className="display text-4xl font-bold tabular-nums"
                    style={{ color: hasAmount ? 'var(--success)' : 'var(--subtle)' }}
                  >
                    {hasAmount ? usdcOut.toFixed(2) : '0.00'}
                  </span>
                  <span className="text-base font-semibold" style={{ color:'var(--muted)' }}>USDC</span>
                </div>
                <TokenUSDC variant="branded" size={28} />
              </div>
              <p className="mt-1 text-xs" style={{ color:'var(--subtle)' }}>
                {hasAmount
                  ? `Rate ₦${usdcRate.toLocaleString('en-NG')} · parallel market`
                  : 'Enter an amount above'}
              </p>
            </div>
          </div>

          {/* ── 2. Destination wallet (slides in after amount entered) ──── */}
          <AnimatePresence>
            {hasAmount && (
              <motion.div
                key="wallet-card"
                initial={{ opacity:0, y:12 }}
                animate={{ opacity:1, y:0 }}
                exit={{ opacity:0, y:8 }}
                transition={{ duration:0.22, ease:'easeOut' }}
                className="rounded-3xl p-5"
                style={glass.card}
              >
                <label
                  className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest"
                  style={{ color:'var(--muted)' }}
                >
                  <Wallet className="size-3" />
                  Destination Wallet
                </label>

                <div
                  className="flex items-center gap-2 rounded-2xl px-4 py-3"
                  style={{
                    ...glass.soft,
                    border: `1px solid ${walletInput && !addressValid ? 'rgba(192,57,43,0.40)' : 'var(--glass-soft-border)'}`,
                  }}
                >
                  <input
                    type="text"
                    value={walletInput}
                    onChange={e => setWalletInput(e.target.value.trim())}
                    placeholder="0x… Arc-compatible wallet address"
                    spellCheck={false}
                    autoComplete="off"
                    className="mono w-full bg-transparent text-sm outline-none placeholder:font-sans placeholder:not-italic placeholder:text-slate-400"
                    style={{ color:'var(--ink)', fontSize:'0.78rem' }}
                  />
                  {addressValid && (
                    <span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background:'var(--accent-dim)', color:'var(--success)' }}>
                      Valid
                    </span>
                  )}
                </div>

                {walletInput && !addressValid && (
                  <p className="mt-1.5 text-xs" style={{ color:'var(--danger)' }}>
                    Enter a valid EVM address (0x…, 42 characters)
                  </p>
                )}

                {/* Balance row */}
                <AnimatePresence>
                  {addressValid && (
                    <motion.div
                      key="balance"
                      initial={{ opacity:0, height:0 }}
                      animate={{ opacity:1, height:'auto' }}
                      exit={{ opacity:0, height:0 }}
                      transition={{ duration:0.18 }}
                      className="overflow-hidden"
                    >
                      <div
                        className="mt-3 flex items-center justify-between rounded-2xl px-4 py-2.5"
                        style={{ background:'var(--accent-dim)', border:'1px solid rgba(82,179,110,0.20)' }}
                      >
                        <div className="flex items-center gap-2">
                          <TokenUSDC variant="branded" size={16} />
                          <span className="text-xs font-semibold" style={{ color:'var(--ink-2)' }}>
                            Current balance · Arc Testnet
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {balanceLoad
                            ? <Loader2 className="size-3.5 animate-spin" style={{ color:'var(--muted)' }} />
                            : <span className="display text-sm font-bold tabular-nums" style={{ color:'var(--success)' }}>
                                {usdcBalance ?? '0.00'}
                              </span>
                          }
                          <span className="text-xs font-medium" style={{ color:'var(--muted)' }}>USDC</span>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <p className="mt-2 text-xs" style={{ color:'var(--subtle)' }}>
                  USDC will be sent to this address on Arc Testnet instantly after payment.
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── 3. Buy CTA ───────────────────────────────────────────────── */}
          <AnimatePresence>
            {hasAmount && (
              <motion.div
                key="cta"
                initial={{ opacity:0, y:8 }}
                animate={{ opacity:1, y:0 }}
                exit={{ opacity:0, y:4 }}
                transition={{ duration:0.2, delay:0.05 }}
              >
                <button
                  disabled={!canBuy}
                  onClick={() => setBuyOpen(true)}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl py-4 text-sm font-bold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ background:'var(--accent)' }}
                >
                  <ShoppingCart className="size-4" />
                  {!walletInput
                    ? 'Enter a destination wallet above'
                    : !addressValid
                    ? 'Invalid wallet address'
                    : `Buy ${usdcOut.toFixed(2)} USDC for ₦${parsedNgn.toLocaleString('en-NG')}`}
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── 4. How it works ──────────────────────────────────────────── */}
          <div className="rounded-2xl p-4" style={glass.soft}>
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest" style={{ color:'var(--muted)' }}>
              How it works
            </p>
            <ol className="space-y-2.5">
              {([
                ['Enter a Naira amount',       'See your USDC quote instantly'],
                ['Add your wallet address',    'Any Arc-compatible EVM wallet'],
                ['Pay via Flutterwave',        'Bank transfer, card, or USSD'],
                ['USDC delivered on-chain',    'Hits your wallet in seconds'],
              ] as [string, string][]).map(([title, sub], i) => (
                <li key={i} className="flex items-start gap-3">
                  <span
                    className="display flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                    style={{ background:'var(--accent)' }}
                  >
                    {i + 1}
                  </span>
                  <div>
                    <p className="text-xs font-semibold" style={{ color:'var(--ink)' }}>{title}</p>
                    <p className="text-xs" style={{ color:'var(--subtle)' }}>{sub}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <p className="text-center text-xs" style={{ color:'var(--subtle)' }}>
            Powered by Flutterwave · Rates by Monierate parallel market
          </p>
        </main>
      </div>

      {/* key remounts BuySheet fresh on each open so internal state always resets cleanly */}
      {buyOpen && (
        <BuySheet
          key={`buy-${parsedNgn}-${walletAddress}`}
          open={buyOpen}
          onClose={() => setBuyOpen(false)}
          usdcRate={usdcRate}
          walletAddress={walletAddress}
          ngnAmount={parsedNgn}
          lockedUsdcAmount={usdcOut > 0 ? usdcOut.toFixed(2) : undefined}
        />
      )}
    </div>
  )
}
