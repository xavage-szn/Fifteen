import { useState, useEffect, useRef } from 'react'

/**
 * Reads the USDC balance on Arc Testnet for any EVM address.
 * Calls through the backend proxy (/api/balance/:address) so the browser
 * never has to reach the Arc RPC directly — avoids any CORS / network issues.
 * Refreshes every 15 seconds automatically.
 */
export function useUsdcBalance(address: `0x${string}` | undefined) {
  const [formatted,  setFormatted]  = useState<string | null>(null)
  const [isLoading,  setIsLoading]  = useState(false)
  const intervalRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeAddr   = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
    activeAddr.current = address
    if (!address) return

    async function fetchBalance(snap: string) {
      setIsLoading(true)
      try {
        const res  = await fetch(`/api/balance/${snap}`)
        const data = await res.json() as { balance?: string; error?: string }
        if (activeAddr.current === snap) {
          setFormatted(data.balance ?? '0.00')
        }
      } catch (err) {
        console.warn('[useUsdcBalance] fetch failed:', err)
        if (activeAddr.current === snap) setFormatted('0.00')
      } finally {
        if (activeAddr.current === snap) setIsLoading(false)
      }
    }

    void fetchBalance(address)
    intervalRef.current = setInterval(() => { void fetchBalance(address) }, 15_000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [address])

  return {
    formatted: address ? formatted : null,
    isLoading: address ? isLoading : false,
  }
}
