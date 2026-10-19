import { useState, useEffect, useRef } from 'react'
import { createPublicClient, http, erc20Abi } from 'viem'
import { getUsdc, requireChain } from '@/onchain-facts'
import { Amount } from '@/onchain-money'
import { ARC_TESTNET_CHAIN_ID } from '@/constants'

// Build a viem public client pointed directly at the working Arc Testnet RPC.
// We bypass wagmi's built-in arcTestnet chain definition because its bundled
// RPC URL (rpc.testnet.arc.network) is unreachable — our registry has the
// correct one (rpc.testnet.arc.io).
const arcChain = requireChain(ARC_TESTNET_CHAIN_ID)
const usdc     = getUsdc(ARC_TESTNET_CHAIN_ID)

const arcViemChain = {
  id:             arcChain.chainId,
  name:           arcChain.name,
  nativeCurrency: {
    name:     arcChain.nativeCurrency.symbol,
    symbol:   arcChain.nativeCurrency.symbol,
    decimals: arcChain.nativeCurrency.decimals,
  },
  rpcUrls: { default: { http: [arcChain.rpcUrls[0]] } },
} as const

const publicClient = createPublicClient({
  chain:     arcViemChain,
  transport: http(arcChain.rpcUrls[0]),
})

/**
 * Reads the USDC ERC-20 balance on Arc Testnet for any EVM address.
 * Uses a direct viem publicClient (not wagmi) so it always hits the
 * correct RPC regardless of wagmi's chain config.
 * Refreshes every 15 s automatically.
 */
export function useUsdcBalance(address: `0x${string}` | undefined) {
  const [formatted, setFormatted] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Track the address the current fetch was started for so stale responses
  // from a previous address are silently dropped.
  const activeAddress = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }

    activeAddress.current = address

    if (!address || !usdc) return   // derived reset happens via render (formatted stays stale but is hidden)

    async function fetchBalance(addrSnapshot: string) {
      if (!usdc) return
      setIsLoading(true)
      try {
        const raw = await publicClient.readContract({
          address:      usdc.address as `0x${string}`,
          abi:          erc20Abi,
          functionName: 'balanceOf',
          args:         [addrSnapshot as `0x${string}`],
        })
        // Only update state if this address is still the active one
        if (activeAddress.current === addrSnapshot) {
          setFormatted(Amount.fromRaw(raw, usdc.decimals).toFixed(2))
        }
      } catch {
        if (activeAddress.current === addrSnapshot) setFormatted('—')
      } finally {
        if (activeAddress.current === addrSnapshot) setIsLoading(false)
      }
    }

    void fetchBalance(address)
    intervalRef.current = setInterval(() => { void fetchBalance(address) }, 15_000)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [address])

  // When address clears, derive null during render rather than inside an effect
  const effectiveFormatted = address ? formatted : null
  const effectiveLoading   = address ? isLoading  : false

  return { formatted: effectiveFormatted, isLoading: effectiveLoading }
}
