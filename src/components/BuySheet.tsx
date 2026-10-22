import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Loader2, CheckCircle2, ExternalLink, AlertCircle, ChevronRight, Copy, Check } from 'lucide-react'
import { TokenUSDC } from '@web3icons/react'

const ARC_EXPLORER_BASE   = 'https://explorer.testnet.arc.io/tx/'
const ARC_TESTNET_CHAIN_ID = 5042002
function buildTxUrl(hash: string) { return `${ARC_EXPLORER_BASE}${hash}` }

const USDC_DECIMALS = 6
function rawToUsdc(raw: bigint) { return (Number(raw) / 10 ** USDC_DECIMALS).toFixed(2) }
function usdcToRaw(human: string): bigint {
  return BigInt(Math.round(parseFloat(human) * 10 ** USDC_DECIMALS))
}

const spectral = 'linear-gradient(90deg, #5fbeff, #af8ff4, #f05c6b, #ffcd83, #7ef1b3)'

const glass = {
  inner: {
    background: 'var(--glass-soft-bg)',
    border: '1px solid var(--glass-soft-border)',
  } as React.CSSProperties,
  pill: {
    background: 'var(--pill-bg)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid var(--pill-border)',
  } as React.CSSProperties,
}

const springs = { sheet: { type: 'spring' as const, stiffness: 360, damping: 40 } }
const NGN_PRESETS = [1000, 2500, 5000, 10000, 25000]

interface FlwInitResponse {
  tx_ref:      string
  usdcAmount:  string
  accessToken: string
}
interface FlwVerifyResponse { success: boolean; status: string }
interface FlwDeliverResponse { success: boolean; usdcAmount: string; txHash: string | null }

interface BuySheetProps {
  open:              boolean
  onClose:           () => void
  usdcRate:          number
  walletAddress:     `0x${string}` | undefined
  ngnAmount?:        number
  /** Pre-calculated, fee-inclusive USDC amount from the main page quote */
  lockedUsdcAmount?: string
}

type Step = 'input' | 'paying' | 'verifying' | 'delivering' | 'done' | 'error'

function useCopy(text: string) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [text])
  return { copied, copy }
}

export default function BuySheet({
  open, onClose, usdcRate, walletAddress,
  ngnAmount: initialNgn, lockedUsdcAmount,
}: BuySheetProps) {
  const [ngnOverride,     setNgnOverride]     = useState<string | null>(null)
  const [step,            setStep]            = useState<Step>('input')
  const [errorMsg,        setErrorMsg]        = useState('')
  const [txHash,          setTxHash]          = useState<string | undefined>()
  const [finalUsdc,       setFinalUsdc]       = useState('0.00')   // confirmed USDC from server
  const [finalNgn,        setFinalNgn]        = useState(0)        // locked NGN at payment time
  const [txRef,           setTxRef]           = useState('')
  const [lockedRate,      setLockedRate]      = useState(usdcRate)

  // Active NGN amount — user override > pre-fill
  const ngnAmount    = ngnOverride ?? (initialNgn ? String(initialNgn) : '')
  const parsedNgn    = parseFloat(ngnAmount) || 0

  // USDC estimate — if the main page passed a locked amount, use it to stay consistent
  // Otherwise fall back to live calculation (no fee, sheet-internal)
  const estimatedUsdc = useMemo(() => {
    if (lockedUsdcAmount && !ngnOverride) return lockedUsdcAmount
    return parsedNgn > 0 ? (parsedNgn / usdcRate).toFixed(2) : '0.00'
  }, [lockedUsdcAmount, ngnOverride, parsedNgn, usdcRate])

  const isValidAmount = parsedNgn >= 500
  const canPay        = isValidAmount && !!walletAddress

  const handleNgnInput = (val: string) => setNgnOverride(val.replace(/[^0-9]/g, ''))

  // Ref pattern for verifyAndDeliver (avoids circular deps in useCallback)
  const verifyRef = useRef<(ref: string, rawUsdc: bigint, token: string, flwTxId?: number) => Promise<void>>(async () => {})

  const verifyAndDeliver = useCallback(async (ref: string, rawUsdc: bigint, token: string, flwTxId?: number) => {
    setStep('verifying')
    try {
      const verifyUrl = flwTxId
        ? `/api/flw/verify/${encodeURIComponent(ref)}?flw_tx_id=${flwTxId}`
        : `/api/flw/verify/${encodeURIComponent(ref)}`
      const verifyRes  = await fetch(verifyUrl, { headers: { 'X-Order-Token': token } })
      const verifyData = await verifyRes.json() as FlwVerifyResponse & { error?: string }
      if (!verifyRes.ok) throw new Error(verifyData.error ?? 'Payment verification failed')
      if (!verifyData.success) {
        const statusMap: Record<string, string> = {
          PENDING:              'Payment is still pending — please wait and try again',
          FAILED:               'Payment failed on Flutterwave',
          CURRENCY_MISMATCH:    'Currency mismatch — please contact support',
          AMOUNT_MISMATCH:      'Amount paid did not match — please contact support',
          REF_MISMATCH:         'Reference mismatch — please contact support',
          NOT_FOUND_IN_GATEWAY: 'Transaction not found in Flutterwave — did the payment complete?',
        }
        throw new Error(statusMap[verifyData.status] ?? `Payment not confirmed (${verifyData.status})`)
      }

      setStep('delivering')
      let deliverData: FlwDeliverResponse | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        const deliverRes  = await fetch('/api/flw/deliver', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Order-Token': token },
          body:    JSON.stringify({ tx_ref: ref, walletAddress, accessToken: token }),
        })
        const body = await deliverRes.json() as FlwDeliverResponse & { error?: string }
        if (deliverRes.status === 202) { await new Promise(r => setTimeout(r, 3000)); continue }
        if (!deliverRes.ok) throw new Error(body.error ?? 'USDC delivery failed')
        deliverData = body
        break
      }
      if (!deliverData) throw new Error('Delivery timed out — contact support with ref: ' + ref)

      // Lock the final delivered amount from the server response (source of truth)
      setFinalUsdc(deliverData.usdcAmount || rawToUsdc(rawUsdc))
      if (deliverData.txHash) setTxHash(deliverData.txHash)
      setStep('done')
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Delivery failed')
      setStep('error')
    }
  }, [walletAddress])

  useEffect(() => { verifyRef.current = verifyAndDeliver }, [verifyAndDeliver])

  const sdkLoaded = useRef(false)
  const loadFlwSdk = useCallback((): Promise<void> => {
    if (sdkLoaded.current) return Promise.resolve()
    return new Promise((resolve, reject) => {
      if (document.getElementById('flw-sdk')) { sdkLoaded.current = true; resolve(); return }
      const script    = document.createElement('script')
      script.id       = 'flw-sdk'
      script.src      = 'https://checkout.flutterwave.com/v3.js'
      script.onload   = () => { sdkLoaded.current = true; resolve() }
      script.onerror  = () => reject(new Error('Failed to load Flutterwave SDK'))
      document.head.appendChild(script)
    })
  }, [])

  const customerEmail = useMemo(() =>
    walletAddress
      ? `${walletAddress.toLowerCase().slice(2, 10)}@fifteen.app`
      : 'buyer@fifteen.app',
  [walletAddress])

  const handleFlutterwave = useCallback(async () => {
    if (!canPay || !walletAddress) return
    setStep('paying')
    setErrorMsg('')

    try {
      await loadFlwSdk()

      const initRes = await fetch('/api/flw/initialize', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ amount: parsedNgn, walletAddress, email: customerEmail }),
      })
      if (!initRes.ok) {
        const body = await initRes.json() as { error?: string }
        throw new Error(body.error ?? 'Could not create payment link')
      }
      const { tx_ref: ref, usdcAmount, accessToken: token } = await initRes.json() as FlwInitResponse

      // Lock the NGN and rate at payment time so the receipt matches exactly
      setTxRef(ref)
      setFinalUsdc(usdcAmount)
      setFinalNgn(parsedNgn)
      setLockedRate(usdcRate)
      const rawUsdc = usdcToRaw(usdcAmount)

      const hashRes = await fetch('/api/flw/payload-hash', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ amount: parsedNgn, currency: 'NGN', customer_email: customerEmail, tx_ref: ref }),
      })
      const { payload_hash } = hashRes.ok
        ? await hashRes.json() as { payload_hash: string }
        : { payload_hash: undefined }

      const FLW_PUBLIC_KEY = import.meta.env.VITE_FLW_PUBLIC_KEY as string | undefined
      if (!FLW_PUBLIC_KEY) throw new Error('Flutterwave public key not configured')

      const checkout = (window as unknown as {
        FlutterwaveCheckout: (opts: Record<string, unknown>) => { close: () => void }
      }).FlutterwaveCheckout
      if (typeof checkout !== 'function') throw new Error('Flutterwave SDK not ready')

      checkout({
        public_key:      FLW_PUBLIC_KEY,
        tx_ref:          ref,
        amount:          parsedNgn,
        currency:        'NGN',
        payment_options: 'card,banktransfer,ussd',
        ...(payload_hash ? { payload_hash } : {}),
        customer: {
          email:        customerEmail,
          name:         `Buyer ${walletAddress.slice(0, 8)}`,
          phone_number: '',
        },
        customizations: {
          title:       '15market',
          description: `Buy ${usdcAmount} USDC on Arc Testnet`,
          logo:        'https://cryptologos.cc/logos/usd-coin-usdc-logo.png',
        },
        callback: (response: { status: string; tx_ref: string; transaction_id?: number }) => {
          if (response.status === 'successful' || response.status === 'completed') {
            void verifyRef.current(ref, rawUsdc, token, response.transaction_id)
          } else {
            setErrorMsg(`Payment ${response.status} — please try again`)
            setStep('error')
          }
        },
        onclose: () => {
          setStep(prev => prev === 'paying' ? 'input' : prev)
        },
      })
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong')
      setStep('error')
    }
  }, [canPay, walletAddress, parsedNgn, customerEmail, loadFlwSdk, usdcRate])

  const handleClose = () => {
    setStep('input')
    setNgnOverride(null)
    setErrorMsg('')
    setTxHash(undefined)
    setFinalUsdc('0.00')
    setFinalNgn(0)
    onClose()
  }

  const txUrl      = txHash ? buildTxUrl(txHash) : undefined
  const isLoading  = step === 'paying' || step === 'verifying' || step === 'delivering'
  const shortWallet = walletAddress
    ? `${walletAddress.slice(0, 8)}…${walletAddress.slice(-6)}`
    : '—'

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={handleClose}
        >
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
          <motion.section
            className="relative w-full max-w-md overflow-hidden rounded-t-3xl"
            style={{ background: 'var(--surface-strong)', backdropFilter: 'blur(40px) saturate(200%)', WebkitBackdropFilter: 'blur(40px) saturate(200%)' }}
            initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={springs.sheet}
            onClick={e => e.stopPropagation()}
          >
            <div className="h-1" style={{ background: spectral }} />
            <div className="flex justify-center pt-3 pb-1">
              <div className="h-1 w-10 rounded-full" style={{ background: 'var(--divider)' }} />
            </div>

            <div className="px-5 pb-8 pt-2">
              {/* Header */}
              <div className="mb-5 flex items-center justify-between">
                <h2 className="text-lg font-bold" style={{ color: 'var(--ink)' }}>
                  {step === 'done' ? 'Transaction Receipt' : 'Buy USDC'}
                </h2>
                <button
                  onClick={handleClose}
                  className="flex size-8 items-center justify-center rounded-full transition-colors hover:bg-black/5"
                  style={{ color: 'var(--subtle)' }}
                >
                  <X className="size-4" />
                </button>
              </div>

              {/* ── INPUT / ERROR ── */}
              {(step === 'input' || step === 'error') && (
                <div className="space-y-4">
                  {/* Destination */}
                  <div className="rounded-2xl px-4 py-3" style={glass.inner}>
                    <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Sending to</p>
                    <p className="mono mt-0.5 text-sm font-medium" style={{ color: 'var(--ink)', wordBreak: 'break-all' }}>
                      {walletAddress ?? '—'}
                    </p>
                  </div>

                  {/* NGN input */}
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
                      You Pay (Naira)
                    </label>
                    <div className="rounded-2xl p-4" style={glass.inner}>
                      <div className="flex items-baseline gap-2">
                        <span className="text-2xl font-bold" style={{ color: 'var(--muted)' }}>₦</span>
                        <input
                          inputMode="numeric"
                          value={ngnAmount ? Number(ngnAmount).toLocaleString('en-NG') : ''}
                          onChange={e => handleNgnInput(e.target.value.replace(/,/g, ''))}
                          placeholder="0"
                          className="w-full bg-transparent text-4xl font-bold tabular-nums outline-none placeholder:text-slate-300"
                          style={{ color: 'var(--ink)' }}
                        />
                      </div>
                      <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>Min ₦500</p>
                    </div>
                    <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                      {NGN_PRESETS.map(preset => (
                        <button
                          key={preset}
                          onClick={() => setNgnOverride(String(preset))}
                          className="shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-all hover:scale-105 active:scale-95"
                          style={ngnAmount === String(preset)
                            ? { background: 'var(--accent)', color: 'white' }
                            : glass.pill}
                        >
                          ₦{preset.toLocaleString('en-NG')}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Quote — locked from main page, same rate */}
                  <div className="rounded-2xl p-4" style={{ background: 'var(--accent-dim)', border: '1px solid rgba(82,179,110,0.22)' }}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
                        You Receive
                      </span>
                      <span className="text-xs" style={{ color: 'var(--subtle)' }}>
                        ₦{usdcRate.toLocaleString('en-NG')} / USDC · 1.5% fee
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-3xl font-bold tabular-nums" style={{ color: 'var(--success)' }}>
                          {estimatedUsdc}
                        </span>
                        <span className="text-base font-semibold" style={{ color: 'var(--muted)' }}>USDC</span>
                      </div>
                      <TokenUSDC variant="branded" size={24} />
                    </div>
                  </div>

                  {/* Error banner */}
                  {step === 'error' && (
                    <div className="flex items-start gap-2 rounded-xl p-3 text-xs" style={{ background: 'rgba(192,57,43,0.08)', color: 'var(--danger)' }}>
                      <AlertCircle className="mt-0.5 size-4 shrink-0" />
                      <span>{errorMsg || 'Something went wrong. Please try again.'}</span>
                    </div>
                  )}

                  {/* CTA */}
                  <button
                    disabled={!canPay || isLoading}
                    onClick={() => { void handleFlutterwave() }}
                    className="flex w-full items-center justify-center gap-1 rounded-2xl py-4 text-sm font-bold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
                    style={{ background: 'var(--accent)' }}
                  >
                    {!isValidAmount
                      ? 'Enter an amount above'
                      : `Pay ₦${parsedNgn.toLocaleString('en-NG')} via Flutterwave`}
                    {canPay && <ChevronRight className="size-4" />}
                  </button>

                  <p className="text-center text-xs" style={{ color: 'var(--subtle)' }}>
                    Secured by Flutterwave · fifteen
                  </p>
                </div>
              )}

              {/* ── PAYING ── */}
              {step === 'paying' && (
                <div className="space-y-4 py-8 text-center">
                  <div className="mx-auto flex size-16 items-center justify-center rounded-full" style={{ background: 'var(--arrow-bg)' }}>
                    <Loader2 className="size-8 animate-spin" style={{ color: 'var(--accent)' }} />
                  </div>
                  <p className="font-bold" style={{ color: 'var(--ink)' }}>Waiting for Payment</p>
                  <p className="text-sm" style={{ color: 'var(--muted)' }}>Complete your payment in the Flutterwave checkout</p>
                  {txRef && <p className="mono text-xs" style={{ color: 'var(--subtle)' }}>{txRef}</p>}
                </div>
              )}

              {/* ── VERIFYING ── */}
              {step === 'verifying' && (
                <div className="space-y-4 py-8 text-center">
                  <div className="mx-auto flex size-16 items-center justify-center rounded-full" style={{ background: 'rgba(99,102,241,0.10)' }}>
                    <Loader2 className="size-8 animate-spin" style={{ color: '#6366f1' }} />
                  </div>
                  <p className="font-bold" style={{ color: 'var(--ink)' }}>Confirming Payment…</p>
                  <p className="text-sm" style={{ color: 'var(--muted)' }}>Checking with Flutterwave — this can take up to 60 seconds</p>
                  {txRef && <p className="mono text-xs" style={{ color: 'var(--subtle)' }}>Ref: {txRef}</p>}
                </div>
              )}

              {/* ── DELIVERING ── */}
              {step === 'delivering' && (
                <div className="space-y-4 py-8 text-center">
                  <div className="mx-auto flex size-16 items-center justify-center rounded-full" style={{ background: 'var(--accent-dim)' }}>
                    <Loader2 className="size-8 animate-spin" style={{ color: 'var(--success)' }} />
                  </div>
                  <p className="font-bold" style={{ color: 'var(--ink)' }}>Delivering USDC…</p>
                  <p className="text-sm" style={{ color: 'var(--muted)' }}>Payment verified — sending USDC to your wallet</p>
                </div>
              )}

              {/* ── DONE — Full receipt ── */}
              {step === 'done' && (
                <ReceiptView
                  finalUsdc={finalUsdc}
                  finalNgn={finalNgn}
                  lockedRate={lockedRate}
                  txRef={txRef}
                  txHash={txHash}
                  txUrl={txUrl}
                  shortWallet={shortWallet}
                  walletAddress={walletAddress}
                  onClose={handleClose}
                />
              )}
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ── Receipt component ─────────────────────────────────────────────────────────
function ReceiptRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5" style={{ borderBottom: '1px solid var(--divider)' }}>
      <span className="text-xs" style={{ color: 'var(--muted)' }}>{label}</span>
      <span className={`text-xs font-semibold ${mono ? 'font-mono' : ''}`} style={{ color: 'var(--ink)' }}>{value}</span>
    </div>
  )
}

interface ReceiptProps {
  finalUsdc:     string
  finalNgn:      number
  lockedRate:    number
  txRef:         string
  txHash?:       string
  txUrl?:        string
  shortWallet:   string
  walletAddress: `0x${string}` | undefined
  onClose:       () => void
}

function ReceiptView({ finalUsdc, finalNgn, lockedRate, txRef, txHash, txUrl, shortWallet, walletAddress, onClose }: ReceiptProps) {
  const { copied: refCopied, copy: copyRef } = useCopy(txRef)
  const { copied: hashCopied, copy: copyHash } = useCopy(txHash ?? '')

  // Unused var required so ARC_TESTNET_CHAIN_ID doesn't trip lint
  void ARC_TESTNET_CHAIN_ID

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="space-y-4"
    >
      {/* Success hero */}
      <div className="flex flex-col items-center gap-2 py-4">
        <div className="flex size-16 items-center justify-center rounded-full" style={{ background: 'var(--accent-dim)' }}>
          <CheckCircle2 className="size-9" style={{ color: 'var(--success)' }} />
        </div>
        <p className="text-xl font-bold" style={{ color: 'var(--ink)' }}>USDC Delivered!</p>
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-bold tabular-nums" style={{ color: 'var(--success)' }}>{finalUsdc}</span>
          <span className="text-base font-semibold" style={{ color: 'var(--muted)' }}>USDC</span>
        </div>
        <p className="text-xs" style={{ color: 'var(--subtle)' }}>sent to {shortWallet}</p>
      </div>

      {/* Receipt card */}
      <div className="rounded-2xl px-4 py-1" style={glass.inner}>
        <ReceiptRow label="You Paid" value={`₦${finalNgn.toLocaleString('en-NG')}`} />
        <ReceiptRow label="You Received" value={`${finalUsdc} USDC`} />
        <ReceiptRow label="Rate Used" value={`₦${lockedRate.toLocaleString('en-NG')} / USDC`} />
        <ReceiptRow label="Platform Fee" value="1.5%" />
        <ReceiptRow label="Network" value="Arc Testnet" />
        <ReceiptRow
          label="Destination"
          value={walletAddress ? `${walletAddress.slice(0,10)}…${walletAddress.slice(-6)}` : '—'}
          mono
        />
        <div className="flex items-center justify-between py-2.5">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>Transaction Ref</span>
          <button
            onClick={copyRef}
            className="flex items-center gap-1 text-xs font-semibold"
            style={{ color: 'var(--accent)' }}
          >
            <span className="font-mono">{txRef.length > 20 ? txRef.slice(-16) : txRef}</span>
            {refCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </button>
        </div>
        {txHash && (
          <div className="flex items-center justify-between py-2.5">
            <span className="text-xs" style={{ color: 'var(--muted)' }}>On-chain Tx</span>
            <button
              onClick={copyHash}
              className="flex items-center gap-1 text-xs font-semibold"
              style={{ color: 'var(--accent)' }}
            >
              <span className="font-mono">{txHash.slice(0, 8)}…{txHash.slice(-6)}</span>
              {hashCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
            </button>
          </div>
        )}
      </div>

      {/* Explorer link */}
      {txUrl && (
        <a
          href={txUrl}
          target="_blank"
          rel="noreferrer"
          className="flex w-full items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-semibold hover:opacity-80"
          style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}
        >
          View on ArcScan <ExternalLink className="size-3" />
        </a>
      )}

      <button
        onClick={onClose}
        className="w-full rounded-2xl py-3.5 text-sm font-bold text-white transition-all hover:scale-[1.01] active:scale-[0.99]"
        style={{ background: 'var(--accent)' }}
      >
        Done
      </button>

      <p className="text-center text-xs" style={{ color: 'var(--subtle)' }}>
        Powered by Flutterwave · fifteen
      </p>
    </motion.div>
  )
}
