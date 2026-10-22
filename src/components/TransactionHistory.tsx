import { ExternalLink } from 'lucide-react'
const ARC_TESTNET_CHAIN_ID = 5042002
function buildTxExplorerUrl(_chainId: number, hash: string) {
  return `https://explorer.testnet.arc.io/tx/${hash}`
}

export interface TxRecord {
  id: string
  ngnAmount: number
  usdcAmount: string
  txHash?: string
  status: 'pending' | 'success' | 'failed'
  timestamp: number
}

interface Props {
  records: TxRecord[]
}

export default function TransactionHistory({ records }: Props) {
  if (records.length === 0) return null

  return (
    <section>
      <h3
        className="mb-3 text-xs font-semibold uppercase tracking-widest"
        style={{ color: 'var(--muted)' }}
      >
        Recent Purchases
      </h3>
      <div className="space-y-2">
        {records.map((r) => (
          <div
            key={r.id}
            className="flex items-center justify-between rounded-2xl px-4 py-3"
            style={{
              background: 'rgba(255,255,255,0.54)',
              border: '1px solid rgba(255,255,255,0.56)',
            }}
          >
            <div>
              <p className="text-sm font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>
                +{r.usdcAmount} USDC
              </p>
              <p className="text-xs tabular-nums" style={{ color: 'var(--subtle)' }}>
                ₦{r.ngnAmount.toLocaleString('en-NG')} ·{' '}
                {new Date(r.timestamp).toLocaleDateString('en-NG', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className="rounded-full px-2 py-0.5 text-xs font-semibold"
                style={
                  r.status === 'success'
                    ? { background: 'rgba(26,128,71,0.10)', color: 'var(--success)' }
                    : r.status === 'failed'
                    ? { background: 'rgba(186,43,76,0.10)', color: 'var(--danger)' }
                    : { background: 'rgba(18,45,69,0.07)', color: 'var(--muted)' }
                }
              >
                {r.status === 'success' ? 'Delivered' : r.status === 'failed' ? 'Failed' : 'Pending'}
              </span>
              {r.txHash && (
                <a
                  href={buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, r.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: 'var(--subtle)' }}
                >
                  <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
