import { useState, useEffect } from 'react'
import { isAddress } from 'viem'
import { motion, AnimatePresence } from 'framer-motion'
import { ShoppingCart, Wallet, Loader2, ArrowDown, Sun, Moon } from 'lucide-react'
import { TokenUSDC } from '@web3icons/react'
import BuySheet from '@/components/BuySheet'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'

const FALLBACK_RATE = 1650
const NGN_PRESETS   = [1_000, 2_500, 5_000, 10_000, 25_000]
const PLATFORM_FEE  = 0.015

function ngnToUsdc(ngn: number, rate: number) {
  return (ngn * (1 - PLATFORM_FEE)) / rate
}

function useDarkMode(): [boolean, () => void] {
  const [dark, setDark] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    const saved = localStorage.getItem('15market-theme')
    if (saved) return saved === 'dark'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  useEffect(() => {
    const root = document.documentElement
    if (dark) { root.classList.add('dark') } else { root.classList.remove('dark') }
    localStorage.setItem('15market-theme', dark ? 'dark' : 'light')
  }, [dark])
  return [dark, () => setDark(d => !d)]
}

export default function App() {
  const [buyOpen,      setBuyOpen]     = useState(false)
  const [usdcRate,     setUsdcRate]    = useState(FALLBACK_RATE)
  const [ngnInput,     setNgnInput]    = useState('')
  const [walletInput,  setWalletInput] = useState('')
  const [dark, toggleDark]             = useDarkMode()

  const parsedNgn    = parseInt(ngnInput.replace(/,/g, ''), 10) || 0
  const hasAmount    = parsedNgn >= 500
  const usdcOut      = hasAmount ? ngnToUsdc(parsedNgn, usdcRate) : 0
  const addressValid = isAddress(walletInput.trim())
  const walletAddress = addressValid ? (walletInput.trim() as `0x${string}`) : undefined
  const canBuy       = hasAmount && addressValid

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

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden" style={{ background: 'var(--bg)' }}>

      <div className="relative z-10 mx-auto flex w-full max-w-md flex-1 flex-col overflow-y-auto px-5 pb-6 pt-5">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <header className="mb-8 flex items-center justify-between">
          <span style={{ fontFamily: "'Funny Samurai', sans-serif", fontSize: 21, color: 'var(--accent)', lineHeight: 1 }}>
            fifteen
          </span>
          <button
            onClick={toggleDark}
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="flex size-8 items-center justify-center rounded-full transition-all hover:scale-105 active:scale-95"
            style={{ background: 'var(--toggle-track)' }}
          >
            {dark
              ? <Sun  className="size-4" style={{ color: 'var(--accent)' }} />
              : <Moon className="size-4" style={{ color: 'var(--muted)' }} />
            }
          </button>
        </header>

        <main className="flex flex-1 flex-col gap-7">

          {/* ── You Pay ──────────────────────────────────────────────────── */}
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
              You Pay
            </p>

            {/* Big NGN input — no box, just the number */}
            <div className="flex items-baseline gap-2">
              <span className="display text-3xl font-bold" style={{ color: 'var(--muted)' }}>₦</span>
              <input
                inputMode="numeric"
                value={ngnInput}
                onChange={e => handleNgnKey(e.target.value)}
                placeholder="0"
                className="display min-w-0 flex-1 bg-transparent text-5xl font-bold tabular-nums outline-none placeholder:opacity-20"
                style={{ color: 'var(--ink)' }}
              />
              <span className="shrink-0 text-sm font-bold" style={{ color: 'var(--muted)' }}>NGN</span>
            </div>

            <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>Min ₦500</p>

            {/* Divider */}
            <div className="my-4 h-px" style={{ background: 'var(--divider)' }} />

            {/* Presets */}
            <div className="flex flex-wrap gap-2">
              {NGN_PRESETS.map(p => (
                <button
                  key={p}
                  onClick={() => setNgnInput(p.toLocaleString('en-NG'))}
                  className="rounded-full px-3 py-1.5 text-xs font-semibold transition-all hover:scale-105 active:scale-95"
                  style={ngnInput === p.toLocaleString('en-NG')
                    ? { background: 'var(--accent)', color: '#fff' }
                    : { background: 'var(--accent-dim)', color: 'var(--accent)' }
                  }
                >
                  ₦{p.toLocaleString('en-NG')}
                </button>
              ))}
            </div>
          </div>

          {/* ── Arrow ────────────────────────────────────────────────────── */}
          <div className="flex items-center gap-3">
            <div className="h-px flex-1" style={{ background: 'var(--divider)' }} />
            <ArrowDown className="size-4" style={{ color: 'var(--muted)' }} />
            <div className="h-px flex-1" style={{ background: 'var(--divider)' }} />
          </div>

          {/* ── You Receive ──────────────────────────────────────────────── */}
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
              You Receive
            </p>
            <div className="flex items-baseline gap-2">
              <span
                className="display text-5xl font-bold tabular-nums"
                style={{ color: hasAmount ? 'var(--success)' : 'var(--subtle)' }}
              >
                {hasAmount ? usdcOut.toFixed(2) : '0.00'}
              </span>
              <span className="text-xl font-semibold" style={{ color: 'var(--muted)' }}>USDC</span>
              <TokenUSDC variant="branded" size={22} className="ml-1" />
            </div>
            <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>
              {hasAmount ? 'Live rate applied' : 'Enter an amount above'}
            </p>
          </div>

          {/* ── Destination Wallet (slides in) ───────────────────────────── */}
          <AnimatePresence>
            {hasAmount && (
              <motion.div
                key="wallet"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
              >
                <label className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
                  <Wallet className="size-3" />
                  Destination Wallet
                </label>

                {/* Underline-style input — no box */}
                <div
                  className="flex items-center gap-2 pb-2"
                  style={{ borderBottom: `1.5px solid ${walletInput && !addressValid ? 'var(--danger)' : 'var(--divider)'}` }}
                >
                  <input
                    type="text"
                    value={walletInput}
                    onChange={e => setWalletInput(e.target.value.trim())}
                    placeholder="0x… wallet address"
                    spellCheck={false}
                    autoComplete="off"
                    className="mono flex-1 bg-transparent text-sm outline-none placeholder:font-sans placeholder:not-italic"
                    style={{ color: 'var(--ink)', fontSize: '0.80rem' }}
                  />
                  {addressValid && (
                    <span className="shrink-0 text-xs font-semibold" style={{ color: 'var(--accent)' }}>✓</span>
                  )}
                </div>

                {walletInput && !addressValid && (
                  <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>
                    Enter a valid EVM address (0x…, 42 characters)
                  </p>
                )}

                {/* Balance — inline, no box */}
                <AnimatePresence>
                  {addressValid && (
                    <motion.div
                      key="bal"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.16 }}
                      className="overflow-hidden"
                    >
                      <div className="mt-2 flex items-center gap-1.5">
                        <TokenUSDC variant="branded" size={13} />
                        <span className="text-xs" style={{ color: 'var(--subtle)' }}>Balance:</span>
                        {balanceLoad
                          ? <Loader2 className="size-3 animate-spin" style={{ color: 'var(--muted)' }} />
                          : <span className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>
                              {usdcBalance ?? '0.00'} USDC
                            </span>
                        }
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Buy CTA ──────────────────────────────────────────────────── */}
          <AnimatePresence>
            {hasAmount && (
              <motion.div
                key="cta"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18, delay: 0.04 }}
                className="mt-auto"
              >
                <button
                  disabled={!canBuy}
                  onClick={() => setBuyOpen(true)}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl py-4 text-sm font-bold text-white transition-all hover:opacity-90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-35"
                  style={{ background: 'var(--accent)' }}
                >
                  <ShoppingCart className="size-4" />
                  {!walletInput
                    ? 'Enter a destination wallet'
                    : !addressValid
                    ? 'Invalid wallet address'
                    : `Buy ${usdcOut.toFixed(2)} USDC for ₦${parsedNgn.toLocaleString('en-NG')}`}
                </button>

                <p className="mt-4 text-center text-xs" style={{ color: 'var(--subtle)' }}>
                  Powered by Flutterwave
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── How it works (only when no amount yet) ───────────────────── */}
          {!hasAmount && (
            <div className="mt-auto">
              <p className="mb-3 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
                How it works
              </p>
              <ol className="space-y-3">
                {([
                  ['Enter a Naira amount',    'See your USDC quote instantly'],
                  ['Add your wallet address', 'Any Arc-compatible EVM wallet'],
                  ['Pay via Flutterwave',     'Bank transfer, card, or USSD'],
                  ['USDC delivered on-chain', 'Hits your wallet in seconds'],
                ] as [string, string][]).map(([title, sub], i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span
                      className="display flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                      style={{ background: 'var(--accent)' }}
                    >
                      {i + 1}
                    </span>
                    <div>
                      <p className="text-xs font-semibold" style={{ color: 'var(--ink)' }}>{title}</p>
                      <p className="text-xs" style={{ color: 'var(--subtle)' }}>{sub}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="mt-6 text-center text-xs" style={{ color: 'var(--subtle)' }}>
                Powered by Flutterwave
              </p>
            </div>
          )}

        </main>
      </div>

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
