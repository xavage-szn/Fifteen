import { useState, useCallback, useRef, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Loader2, CheckCircle2, ExternalLink, AlertCircle, Copy, Check, ShieldCheck } from 'lucide-react'
import { TokenUSDC } from '@web3icons/react'

const ARC_EXPLORER_BASE = 'https://explorer.testnet.arc.io/tx/'
function buildTxUrl(hash: string) { return `${ARC_EXPLORER_BASE}${hash}` }

const USDC_DECIMALS = 6
function rawToUsdc(raw: bigint) { return (Number(raw) / 10 ** USDC_DECIMALS).toFixed(2) }
function usdcToRaw(human: string): bigint {
  return BigInt(Math.round(parseFloat(human) * 10 ** USDC_DECIMALS))
}

const springs = { sheet: { type: 'spring' as const, stiffness: 360, damping: 40 } }

interface FlwInitResponse   { tx_ref: string; usdcAmount: string; accessToken: string }
interface FlwVerifyResponse  { success: boolean; status: string }
interface FlwDeliverResponse { success: boolean; usdcAmount: string; txHash: string | null }

interface BuySheetProps {
  open:              boolean
  onClose:           () => void
  usdcRate:          number
  walletAddress:     `0x${string}` | undefined
  ngnAmount?:        number
  lockedUsdcAmount?: string
}

type Step = 'confirm' | 'paying' | 'verifying' | 'delivering' | 'done' | 'error'

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

// Flat divider row used in receipt
function Row({ label, value, mono, accent }: { label: string; value: string; mono?: boolean; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between py-3" style={{ borderBottom: '1px solid var(--divider)' }}>
      <span className="text-xs" style={{ color: 'var(--muted)' }}>{label}</span>
      <span className={`text-xs font-semibold${mono ? ' font-mono' : ''}`}
        style={{ color: accent ? 'var(--accent)' : 'var(--ink)' }}>
        {value}
      </span>
    </div>
  )
}

export default function BuySheet({
  open, onClose, usdcRate, walletAddress,
  ngnAmount: initialNgn, lockedUsdcAmount,
}: BuySheetProps) {
  const [step,      setStep]      = useState<Step>('confirm')
  const [errorMsg,  setErrorMsg]  = useState('')
  const [txHash,    setTxHash]    = useState<string | undefined>()
  const [finalUsdc, setFinalUsdc] = useState(lockedUsdcAmount ?? '0.00')
  const [finalNgn,  setFinalNgn]  = useState(initialNgn ?? 0)
  const [txRef,     setTxRef]     = useState('')

  const parsedNgn   = initialNgn ?? 0
  const displayUsdc = lockedUsdcAmount ?? '0.00'
  const canPay      = parsedNgn >= 500 && !!walletAddress

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
          NOT_FOUND_IN_GATEWAY: 'Transaction not found — did the payment complete?',
        }
        throw new Error(statusMap[verifyData.status] ?? `Payment not confirmed (${verifyData.status})`)
      }

      setStep('delivering')
      let deliverData: FlwDeliverResponse | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        const deliverRes = await fetch('/api/flw/deliver', {
          method:  'POST',
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

      setFinalUsdc(deliverData.usdcAmount || rawToUsdc(rawUsdc))
      if (deliverData.txHash) setTxHash(deliverData.txHash)
      setStep('done')
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Delivery failed')
      setStep('error')
    }
  }, [walletAddress])

  // Tracks whether the Flutterwave callback has already fired with a
  // successful/completed status so onclose doesn't reset a live flow.
  const callbackFired = useRef(false)

  const sdkLoaded = useRef(false)
  const loadFlwSdk = useCallback((): Promise<void> => {
    if (sdkLoaded.current) return Promise.resolve()
    return new Promise((resolve, reject) => {
      if (document.getElementById('flw-sdk')) { sdkLoaded.current = true; resolve(); return }
      const script   = document.createElement('script')
      script.id      = 'flw-sdk'
      script.src     = 'https://checkout.flutterwave.com/v3.js'
      script.onload  = () => { sdkLoaded.current = true; resolve() }
      script.onerror = () => reject(new Error('Failed to load Flutterwave SDK'))
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

      const initRes  = await fetch('/api/flw/initialize', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ amount: parsedNgn, walletAddress, email: customerEmail }),
      })
      const initBody = await initRes.json() as FlwInitResponse & { error?: string }
      if (!initRes.ok) throw new Error(initBody.error ?? 'Could not create payment link')

      const { tx_ref: ref, usdcAmount, accessToken: token } = initBody
      setTxRef(ref)
      setFinalUsdc(usdcAmount)
      setFinalNgn(parsedNgn)
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
      if (!FLW_PUBLIC_KEY) throw new Error('Flutterwave public key not configured — contact support')

      const checkout = (window as unknown as {
        FlutterwaveCheckout: (opts: Record<string, unknown>) => { close: () => void }
      }).FlutterwaveCheckout
      if (typeof checkout !== 'function') throw new Error('Flutterwave checkout SDK not ready')

      // Reset the callback-fired guard each time a new checkout opens.
      callbackFired.current = false

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
          description: `Buy ${usdcAmount} USDC`,
          logo:        'https://cryptologos.cc/logos/usd-coin-usdc-logo.png',
        },
        callback: (response: { status: string; tx_ref: string; transaction_id?: number }) => {
          // Guard: never fire verify twice for the same checkout session.
          if (callbackFired.current) return
          if (response.status === 'successful' || response.status === 'completed') {
            callbackFired.current = true
            void verifyAndDeliver(ref, rawUsdc, token, response.transaction_id)
          } else {
            // Don't treat non-successful callbacks as fatal errors; the user
            // may simply have closed/cancelled before completing — onclose handles that.
            setErrorMsg(`Payment ${response.status} — please try again`)
            setStep('error')
          }
        },
        onclose: () => {
          // Only reset to 'confirm' if no successful callback has been received.
          // If callback already fired (payment went through), leave the step alone
          // so verifyAndDeliver can finish delivering USDC.
          if (!callbackFired.current) {
            setStep(prev => (prev === 'paying' ? 'confirm' : prev))
          }
        },
      })
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong')
      setStep('error')
    }
  }, [canPay, walletAddress, parsedNgn, customerEmail, loadFlwSdk, usdcRate, verifyAndDeliver])

  const handleClose = () => {
    callbackFired.current = false
    setStep('confirm')
    setErrorMsg('')
    setTxHash(undefined)
    setFinalUsdc(lockedUsdcAmount ?? '0.00')
    setFinalNgn(initialNgn ?? 0)
    onClose()
  }

  const txUrl     = txHash ? buildTxUrl(txHash) : undefined
  const isLoading = step === 'paying' || step === 'verifying' || step === 'delivering'

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={handleClose}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <motion.section
            className="relative w-full max-w-md rounded-t-3xl"
            style={{ maxHeight: '92dvh', background: 'var(--bg)' }}
            initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={springs.sheet}
            onClick={e => e.stopPropagation()}
          >
            {/* Top accent line */}
            <div className="h-0.5 rounded-t-3xl" style={{ background: 'var(--accent)' }} />
            <div className="flex justify-center pt-3 pb-1">
              <div className="h-1 w-10 rounded-full" style={{ background: 'var(--divider)' }} />
            </div>

            <div className="overflow-y-auto px-5 pb-8 pt-2" style={{ maxHeight: 'calc(92dvh - 28px)' }}>

              {/* Header */}
              <div className="mb-6 flex items-center justify-between">
                <h2 className="text-base font-bold" style={{ color: 'var(--ink)' }}>
                  {step === 'done' ? 'Transaction Receipt' : 'Confirm Purchase'}
                </h2>
                <button onClick={handleClose} style={{ color: 'var(--muted)' }}>
                  <X className="size-5" />
                </button>
              </div>

              {/* ── CONFIRM / ERROR ── */}
              {(step === 'confirm' || step === 'error') && (
                <div>
                  {/* You Pay row */}
                  <div className="flex items-baseline justify-between pb-4" style={{ borderBottom: '1px solid var(--divider)' }}>
                    <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>You Pay</span>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-3xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
                        ₦{parsedNgn.toLocaleString('en-NG')}
                      </span>
                      <span className="text-xs font-bold" style={{ color: 'var(--muted)' }}>NGN</span>
                    </div>
                  </div>

                  {/* You Receive row */}
                  <div className="flex items-baseline justify-between py-4" style={{ borderBottom: '1px solid var(--divider)' }}>
                    <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>You Receive</span>
                    <div className="flex items-center gap-2">
                      <span className="text-3xl font-bold tabular-nums" style={{ color: 'var(--accent)' }}>
                        {displayUsdc}
                      </span>
                      <span className="text-sm font-semibold" style={{ color: 'var(--muted)' }}>USDC</span>
                      <TokenUSDC variant="branded" size={20} />
                    </div>
                  </div>

                  {/* Destination wallet row */}
                  <div className="py-4" style={{ borderBottom: '1px solid var(--divider)' }}>
                    <p className="mb-0.5 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>To</p>
                    <p className="mono break-all text-xs" style={{ color: 'var(--ink)' }}>
                      {walletAddress ?? '—'}
                    </p>
                  </div>

                  {/* Network */}
                  <div className="flex items-center justify-between py-4" style={{ borderBottom: '1px solid var(--divider)' }}>
                    <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Network</span>
                    <span className="text-xs font-semibold" style={{ color: 'var(--ink)' }}>Arc Testnet</span>
                  </div>

                  {/* Error */}
                  {step === 'error' && (
                    <div className="mt-4 flex items-start gap-2 text-xs" style={{ color: 'var(--danger)' }}>
                      <AlertCircle className="mt-0.5 size-4 shrink-0" />
                      <span>{errorMsg || 'Something went wrong. Please try again.'}</span>
                    </div>
                  )}

                  {/* Pay button */}
                  <button
                    disabled={!canPay || isLoading}
                    onClick={() => { void handleFlutterwave() }}
                    className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl py-4 text-sm font-bold text-white transition-all hover:opacity-90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-35"
                    style={{ background: 'var(--accent)' }}
                  >
                    {isLoading
                      ? <><Loader2 className="size-4 animate-spin" /> Processing…</>
                      : <>Pay ₦{parsedNgn.toLocaleString('en-NG')} via Flutterwave</>
                    }
                  </button>

                  <div className="mt-3 flex items-center justify-center gap-1.5 text-xs" style={{ color: 'var(--subtle)' }}>
                    <ShieldCheck className="size-3.5" style={{ color: 'var(--accent)' }} />
                    Secured by Flutterwave
                  </div>
                </div>
              )}

              {/* ── PAYING ── */}
              {step === 'paying' && (
                <div className="py-12 text-center">
                  <Loader2 className="mx-auto mb-4 size-10 animate-spin" style={{ color: 'var(--accent)' }} />
                  <p className="font-bold" style={{ color: 'var(--ink)' }}>Waiting for Payment</p>
                  <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>Complete payment in the Flutterwave checkout</p>
                  {txRef && <p className="mono mt-2 text-xs" style={{ color: 'var(--subtle)' }}>{txRef}</p>}
                </div>
              )}

              {/* ── VERIFYING ── */}
              {step === 'verifying' && (
                <div className="py-12 text-center">
                  <Loader2 className="mx-auto mb-4 size-10 animate-spin" style={{ color: '#6366f1' }} />
                  <p className="font-bold" style={{ color: 'var(--ink)' }}>Confirming Payment…</p>
                  <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>Checking with Flutterwave</p>
                  {txRef && <p className="mono mt-2 text-xs" style={{ color: 'var(--subtle)' }}>Ref: {txRef}</p>}
                </div>
              )}

              {/* ── DELIVERING ── */}
              {step === 'delivering' && (
                <div className="py-12 text-center">
                  <Loader2 className="mx-auto mb-4 size-10 animate-spin" style={{ color: 'var(--accent)' }} />
                  <p className="font-bold" style={{ color: 'var(--ink)' }}>Delivering USDC…</p>
                  <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>Payment verified — sending to your wallet</p>
                </div>
              )}

              {/* ── DONE — receipt ── */}
              {step === 'done' && (
                <ReceiptView
                  finalUsdc={finalUsdc}
                  finalNgn={finalNgn}
                  txRef={txRef}
                  txHash={txHash}
                  txUrl={txUrl}
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

// ── Receipt ───────────────────────────────────────────────────────────────────
interface ReceiptProps {
  finalUsdc:     string
  finalNgn:      number
  txRef:         string
  txHash?:       string
  txUrl?:        string
  walletAddress: `0x${string}` | undefined
  onClose:       () => void
}

function ReceiptView({ finalUsdc, finalNgn, txRef, txHash, txUrl, walletAddress, onClose }: ReceiptProps) {
  const { copied: refCopied,  copy: copyRef  } = useCopy(txRef)
  const { copied: hashCopied, copy: copyHash } = useCopy(txHash ?? '')

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
    >
      {/* Hero */}
      <div className="mb-6 flex flex-col items-center gap-1 pt-2 text-center">
        <CheckCircle2 className="size-12 mb-1" style={{ color: 'var(--accent)' }} />
        <p className="text-lg font-bold" style={{ color: 'var(--ink)' }}>USDC Delivered!</p>
        <div className="flex items-baseline gap-1">
          <span className="text-4xl font-bold tabular-nums" style={{ color: 'var(--accent)' }}>{finalUsdc}</span>
          <span className="text-lg font-semibold" style={{ color: 'var(--muted)' }}>USDC</span>
        </div>
      </div>

      {/* Flat rows */}
      <Row label="You Paid"     value={`₦${finalNgn.toLocaleString('en-NG')}`} />
      <Row label="You Received" value={`${finalUsdc} USDC`} accent />
      <Row label="Network"      value="Arc Testnet" />
      <Row label="Destination"  value={walletAddress ? `${walletAddress.slice(0,10)}…${walletAddress.slice(-6)}` : '—'} mono />

      {/* Tx Ref */}
      <div className="flex items-center justify-between py-3" style={{ borderBottom: '1px solid var(--divider)' }}>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>Transaction Ref</span>
        <button onClick={copyRef} className="flex items-center gap-1 text-xs font-semibold" style={{ color: 'var(--accent)' }}>
          <span className="font-mono">{txRef.length > 20 ? txRef.slice(-16) : txRef}</span>
          {refCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
      </div>

      {/* On-chain hash */}
      {txHash && (
        <div className="flex items-center justify-between py-3" style={{ borderBottom: '1px solid var(--divider)' }}>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>On-chain Tx</span>
          <button onClick={copyHash} className="flex items-center gap-1 text-xs font-semibold" style={{ color: 'var(--accent)' }}>
            <span className="font-mono">{txHash.slice(0,8)}…{txHash.slice(-6)}</span>
            {hashCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </button>
        </div>
      )}

      {txUrl && (
        <a href={txUrl} target="_blank" rel="noreferrer"
          className="mt-4 flex w-full items-center justify-center gap-1.5 text-xs font-semibold"
          style={{ color: 'var(--accent)' }}
        >
          View on ArcScan <ExternalLink className="size-3" />
        </a>
      )}

      <button
        onClick={onClose}
        className="mt-6 w-full rounded-2xl py-4 text-sm font-bold text-white transition-all hover:opacity-90 active:scale-[0.99]"
        style={{ background: 'var(--accent)' }}
      >
        Done
      </button>

      <p className="mt-3 text-center text-xs" style={{ color: 'var(--subtle)' }}>
        Powered by Flutterwave
      </p>
    </motion.div>
  )
}
