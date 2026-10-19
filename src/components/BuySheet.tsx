import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Loader2, CheckCircle2, ExternalLink, AlertCircle, ChevronRight } from 'lucide-react'
import { buildTxExplorerUrl } from '@/onchain-facts'
import { parseAmount, Amount } from '@/onchain-money'
import { ARC_TESTNET_CHAIN_ID } from '@/constants'

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

const springs = {
  sheet: { type: 'spring' as const, stiffness: 360, damping: 40 },
}

const NGN_PRESETS = [1000, 2500, 5000, 10000, 25000]

function ngnToUsdc(ngn: number, rate: number): string {
  return (ngn / rate).toFixed(2)
}

interface FlwInitResponse {
  paymentLink:  string
  tx_ref:       string
  usdcAmount:   string
  accessToken:  string   // per-transaction HMAC token — required on verify + deliver
}

interface FlwVerifyResponse {
  success: boolean
  status:  string
}

interface FlwDeliverResponse {
  success:    boolean
  usdcAmount: string
  txHash:     string | null
}

interface BuySheetProps {
  open:          boolean
  onClose:       () => void
  usdcRate:      number
  walletAddress: `0x${string}` | undefined
  /** Pre-filled NGN amount from the main page buy widget */
  ngnAmount?:    number
}

type Step = 'input' | 'paying' | 'verifying' | 'delivering' | 'done' | 'error'

export default function BuySheet({ open, onClose, usdcRate, walletAddress, ngnAmount: initialNgn }: BuySheetProps) {
  // ngnOverride is set when the user edits the amount inside the sheet.
  // When null, we fall back to initialNgn (pre-filled from the main page).
  const [ngnOverride, setNgnOverride]   = useState<string | null>(null)
  const [step, setStep]                 = useState<Step>('input')
  const [errorMsg, setErrorMsg]         = useState('')
  const [txHash, setTxHash]             = useState<string | undefined>()
  const [usdcToDeliver, setUsdcToDeliver] = useState<bigint>(0n)
  const [txRef, setTxRef]               = useState<string>('')

  // The displayed/active NGN amount: user's override takes priority, else the pre-fill
  const ngnAmount = ngnOverride ?? (initialNgn ? String(initialNgn) : '')
  const setNgnAmount = (v: string) => setNgnOverride(v)

  const parsedNgn     = parseFloat(ngnAmount) || 0
  const estimatedUsdc = parsedNgn > 0 ? ngnToUsdc(parsedNgn, usdcRate) : '0.00'
  const isValidAmount = parsedNgn >= 500
  const canPay        = isValidAmount && !!walletAddress

  const handleNgnInput = (val: string) => setNgnAmount(val.replace(/[^0-9]/g, ''))

  // Ref pattern: keeps verifyAndDeliver callable from the popup-close poll
  // without a circular useCallback dependency.
  const verifyRef = useRef<(ref: string, rawUsdc: bigint, token: string, flwTxId?: number) => Promise<void>>(async () => { /* noop */ })

  const verifyAndDeliver = useCallback(async (ref: string, rawUsdc: bigint, token: string, flwTxId?: number) => {
    setStep('verifying')
    try {
      // Step 1 — server verifies with Flutterwave (retries up to 6× with backoff)
      // Pass flwTxId when available so the server can verify by transaction ID (faster)
      const verifyUrl = flwTxId
        ? `/api/flw/verify/${encodeURIComponent(ref)}?flw_tx_id=${flwTxId}`
        : `/api/flw/verify/${encodeURIComponent(ref)}`
      const verifyRes = await fetch(verifyUrl, {
        headers: { 'X-Order-Token': token },
      })
      const verifyData = await verifyRes.json() as FlwVerifyResponse
      if (!verifyRes.ok) {
        throw new Error((verifyData as { error?: string }).error ?? 'Payment verification failed')
      }
      if (!verifyData.success) {
        const statusMap: Record<string, string> = {
          PENDING:             'Payment is still pending — please wait and try again',
          FAILED:              'Payment failed on Flutterwave',
          CURRENCY_MISMATCH:   'Currency mismatch — please contact support',
          AMOUNT_MISMATCH:     'Amount paid did not match — please contact support',
          REF_MISMATCH:        'Reference mismatch — please contact support',
          NOT_FOUND_IN_GATEWAY:'Transaction not found in Flutterwave — did the payment complete?',
        }
        const readable = statusMap[verifyData.status] ?? `Payment not confirmed (${verifyData.status})`
        throw new Error(readable)
      }

      // Step 2 — deliver USDC only after verification passes
      // Retry once on 202 (delivery already in-flight) to handle duplicate callbacks
      let deliverData: FlwDeliverResponse | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        const deliverRes = await fetch('/api/flw/deliver', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'X-Order-Token': token },
          body:    JSON.stringify({ tx_ref: ref, walletAddress, accessToken: token }),
        })
        const body = await deliverRes.json() as FlwDeliverResponse & { error?: string; status?: string }
        if (deliverRes.status === 202) {
          // Delivery in-flight — wait 3s and retry
          await new Promise(r => setTimeout(r, 3000))
          continue
        }
        if (!deliverRes.ok) throw new Error(body.error ?? 'USDC delivery failed')
        deliverData = body
        break
      }
      if (!deliverData) throw new Error('Delivery timed out — please contact support with your ref: ' + ref)

      setUsdcToDeliver(rawUsdc)
      if (deliverData.txHash) setTxHash(deliverData.txHash)
      setStep('done')
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Delivery failed')
      setStep('error')
    }
  }, [walletAddress])

  useEffect(() => { verifyRef.current = verifyAndDeliver }, [verifyAndDeliver])

  // Lazily load the Flutterwave Inline JS SDK once
  const sdkLoaded = useRef(false)
  const loadFlwSdk = useCallback((): Promise<void> => {
    if (sdkLoaded.current) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const existing = document.getElementById('flw-sdk')
      if (existing) { sdkLoaded.current = true; resolve(); return }
      const script = document.createElement('script')
      script.id  = 'flw-sdk'
      script.src = 'https://checkout.flutterwave.com/v3.js'
      script.onload  = () => { sdkLoaded.current = true; resolve() }
      script.onerror = () => reject(new Error('Failed to load Flutterwave SDK'))
      document.head.appendChild(script)
    })
  }, [])

  // Stable customer email derived from wallet address (no sensitive data)
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
      // 1 — Load Flutterwave inline SDK
      await loadFlwSdk()

      // 2 — Reserve the order and get tx_ref + expected USDC from server
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

      setTxRef(ref)
      const rawAmount = parseAmount(ARC_TESTNET_CHAIN_ID, usdcAmount)
      setUsdcToDeliver(rawAmount.raw)

      // 3 — Fetch tamper-proof payload_hash from server (secret key stays server-side)
      const hashRes = await fetch('/api/flw/payload-hash', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ amount: parsedNgn, currency: 'NGN', customer_email: customerEmail, tx_ref: ref }),
      })
      const { payload_hash } = hashRes.ok
        ? await hashRes.json() as { payload_hash: string }
        : { payload_hash: undefined }

      // 4 — Launch Flutterwave Inline modal (callback mode, no redirect)
      const FLW_PUBLIC_KEY = import.meta.env.VITE_FLW_PUBLIC_KEY as string | undefined
      if (!FLW_PUBLIC_KEY) throw new Error('Flutterwave public key not configured')

      // FlutterwaveCheckout is injected by the SDK script at runtime
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
          // Flutterwave calls this when payment is done
          if (response.status === 'successful' || response.status === 'completed') {
            // Pass token + transaction_id for fast, authorized server-side verification
            void verifyRef.current(ref, rawAmount.raw, token, response.transaction_id)
          } else {
            setErrorMsg(`Payment ${response.status} — please try again`)
            setStep('error')
          }
        },
        onclose: () => {
          // User closed modal without completing — go back to input unless already delivering
          setStep((prev) => (prev === 'paying' ? 'input' : prev))
        },
      })
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong')
      setStep('error')
    }
  }, [canPay, walletAddress, parsedNgn, customerEmail, loadFlwSdk])

  const handleClose = () => {
    setStep('input')
    setNgnOverride(null)   // revert to initialNgn pre-fill on next open
    setErrorMsg('')
    setTxHash(undefined)
    onClose()
  }

  const txUrl     = txHash ? buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, txHash) : undefined
  const isLoading = step === 'paying' || step === 'verifying' || step === 'delivering'

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={handleClose}
        >
          <div className="absolute inset-0 bg-black/25 backdrop-blur-sm" />
          <motion.section
            className="relative w-full max-w-md overflow-hidden rounded-t-3xl"
            style={{
              background:            'var(--surface-strong)',
              backdropFilter:        'blur(40px) saturate(200%)',
              WebkitBackdropFilter:  'blur(40px) saturate(200%)',
            }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={springs.sheet}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="h-1" style={{ background: spectral }} />
            <div className="flex justify-center pt-3 pb-1">
              <div className="h-1 w-10 rounded-full bg-black/10" />
            </div>

            <div className="px-5 pb-8 pt-2">
              {/* Header */}
              <div className="mb-5 flex items-center justify-between">
                <h2 className="display text-lg font-bold" style={{ color: 'var(--ink)' }}>
                  Buy USDC
                </h2>
                <button
                  onClick={handleClose}
                  className="flex size-8 items-center justify-center rounded-full transition-colors hover:bg-black/5"
                  style={{ color: 'var(--subtle)' }}
                >
                  <X className="size-4" />
                </button>
              </div>

              {/* ── Input / Error step ── */}
              {(step === 'input' || step === 'error') && (
                <div className="space-y-4">
                  {/* Destination address */}
                  <div className="rounded-2xl px-4 py-3" style={glass.inner}>
                    <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
                      Sending to
                    </p>
                    <p className="mono mt-0.5 text-sm font-medium" style={{ color: 'var(--ink)' }}>
                      {walletAddress
                        ? `${walletAddress.slice(0, 10)}…${walletAddress.slice(-8)}`
                        : '—'}
                    </p>
                  </div>

                  {/* NGN amount input */}
                  <div>
                    <label
                      className="mb-1.5 block text-xs font-semibold uppercase tracking-widest"
                      style={{ color: 'var(--muted)' }}
                    >
                      You Pay (Naira)
                    </label>
                    <div className="rounded-2xl p-4" style={glass.inner}>
                      <div className="flex items-baseline gap-2">
                        <span className="display text-2xl font-bold" style={{ color: 'var(--muted)' }}>₦</span>
                        <input
                          inputMode="numeric"
                          value={ngnAmount ? Number(ngnAmount).toLocaleString('en-NG') : ''}
                          onChange={(e) => handleNgnInput(e.target.value.replace(/,/g, ''))}
                          placeholder="0"
                          className="display w-full bg-transparent text-4xl font-bold tabular-nums outline-none placeholder:text-slate-300"
                          style={{ color: 'var(--ink)' }}
                        />
                      </div>
                      <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>Min ₦500</p>
                    </div>

                    {/* Presets */}
                    <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                      {NGN_PRESETS.map((preset) => (
                        <button
                          key={preset}
                          onClick={() => setNgnAmount(String(preset))}
                          className="shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-all hover:scale-105 active:scale-95"
                          style={
                            ngnAmount === String(preset)
                              ? { background: 'var(--accent)', color: 'white' }
                              : glass.pill
                          }
                        >
                          ₦{preset.toLocaleString('en-NG')}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* USDC estimate */}
                  <div className="rounded-2xl p-4" style={glass.inner}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
                        You Receive
                      </span>
                      <span className="text-xs" style={{ color: 'var(--subtle)' }}>
                        Rate: ₦{usdcRate.toLocaleString('en-NG')} / USDC
                      </span>
                    </div>
                    <div className="mt-2 flex items-baseline gap-1.5">
                      <span className="display text-3xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
                        {estimatedUsdc}
                      </span>
                      <span className="text-base font-semibold" style={{ color: 'var(--subtle)' }}>USDC</span>
                    </div>
                  </div>

                  {/* Fee */}
                  <div className="flex items-center justify-between px-1 text-xs" style={{ color: 'var(--subtle)' }}>
                    <span>Platform fee</span>
                    <span className="font-semibold">1.5%</span>
                  </div>

                  {/* Error banner */}
                  {step === 'error' && (
                    <div
                      className="flex items-start gap-2 rounded-xl p-3 text-xs"
                      style={{ background: 'rgba(192,57,43,0.08)', color: 'var(--danger)' }}
                    >
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
                      ? 'Enter an amount'
                      : `Pay ₦${parsedNgn.toLocaleString('en-NG')} via Flutterwave`}
                    {canPay && <ChevronRight className="size-4" />}
                  </button>

                  <p className="text-center text-xs" style={{ color: 'var(--subtle)' }}>
                    Secured by Flutterwave · Hokage
                  </p>
                </div>
              )}

              {/* ── Paying step ── */}
              {step === 'paying' && (
                <div className="space-y-4 py-8 text-center">
                  <div className="mx-auto flex size-16 items-center justify-center rounded-full" style={{ background: 'var(--arrow-bg)' }}>
                    <Loader2 className="size-8 animate-spin" style={{ color: 'var(--accent)' }} />
                  </div>
                  <div>
                    <p className="display font-bold" style={{ color: 'var(--ink)' }}>Waiting for Payment</p>
                    <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
                      Complete your payment in the Flutterwave checkout
                    </p>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--subtle)' }}>
                    Ref: <span className="mono">{txRef}</span>
                  </p>
                </div>
              )}

              {/* ── Verifying step ── */}
              {step === 'verifying' && (
                <div className="space-y-4 py-8 text-center">
                  <div className="mx-auto flex size-16 items-center justify-center rounded-full" style={{ background: 'rgba(99,102,241,0.08)' }}>
                    <Loader2 className="size-8 animate-spin" style={{ color: '#6366f1' }} />
                  </div>
                  <div>
                    <p className="display font-bold" style={{ color: 'var(--ink)' }}>Confirming Payment…</p>
                    <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
                      Checking your payment with Flutterwave — this can take up to 60 seconds
                    </p>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--subtle)' }}>
                    Ref: <span className="mono">{txRef}</span>
                  </p>
                </div>
              )}

              {/* ── Delivering step ── */}
              {step === 'delivering' && (
                <div className="space-y-4 py-8 text-center">
                  <div className="mx-auto flex size-16 items-center justify-center rounded-full" style={{ background: 'var(--accent-dim)' }}>
                    <Loader2 className="size-8 animate-spin" style={{ color: 'var(--success)' }} />
                  </div>
                  <div>
                    <p className="display font-bold" style={{ color: 'var(--ink)' }}>Delivering USDC…</p>
                    <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
                      Payment verified — sending USDC to your wallet
                    </p>
                  </div>
                </div>
              )}

              {/* ── Done step ── */}
              {step === 'done' && (
                <div className="space-y-4 py-6 text-center">
                  <div className="mx-auto flex size-16 items-center justify-center rounded-full" style={{ background: 'var(--accent-dim)' }}>
                    <CheckCircle2 className="size-8" style={{ color: 'var(--success)' }} />
                  </div>
                  <div>
                    <p className="display text-xl font-bold" style={{ color: 'var(--ink)' }}>USDC Delivered!</p>
                    <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
                      <span className="font-semibold tabular-nums" style={{ color: 'var(--success)' }}>
                        {Amount.fromRaw(usdcToDeliver, 6).toFixed(2)} USDC
                      </span>{' '}
                      is on its way to your wallet
                    </p>
                  </div>
                  {txUrl && (
                    <a
                      href={txUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-xs font-semibold hover:underline"
                      style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}
                    >
                      View on ArcScan <ExternalLink className="size-3" />
                    </a>
                  )}
                  <button
                    onClick={handleClose}
                    className="w-full rounded-2xl py-3.5 text-sm font-bold text-white"
                    style={{ background: 'var(--accent)' }}
                  >
                    Done
                  </button>
                </div>
              )}
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
