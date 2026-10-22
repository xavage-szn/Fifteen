import { useState, useEffect, useRef } from 'react'
import { createPublicClient, http, erc20Abi } from 'viem'

// Arc Testnet constants — inlined because this repo has no @/onchain-facts module
const ARC_TESTNET_RPC      = 'https://rpc.testnet.arc.io'
const USDC_ADDRESS         = '0x4D1C97fF68c57DbFEc40B80423208e26a3FbbF79' as const
const USDC_DECIMALS        = 6

const arcViemChain = {
  id:             5042002,
  name:           'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls:        { default: { http: [ARC_TESTNET_RPC] } },
} as const

const publicClient = createPublicClient({
  chain:     arcViemChain,
  transport: http(ARC_TESTNET_RPC),
})

/**
 * Reads the USDC ERC-20 balance on Arc Testnet for any EVM address.
 * Uses a direct viem publicClient (not wagmi) to always hit the correct RPC.
 * Refreshes every 15 s automatically.
 */
export function useUsdcBalance(address: `0x${string}` | undefined) {
  const [formatted, setFormatted] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const intervalRef   = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeAddress = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }

    activeAddress.current = address

    if (!address) return

    async function fetchBalance(addrSnapshot: string) {
      setIsLoading(true)
      try {
        const raw = await publicClient.readContract({
          address:      USDC_ADDRESS,
          abi:          erc20Abi,
          functionName: 'balanceOf',
          args:         [addrSnapshot as `0x${string}`],
        })
        if (activeAddress.current === addrSnapshot) {
          setFormatted((Number(raw) / 10 ** USDC_DECIMALS).toFixed(2))
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

  const effectiveFormatted = address ? formatted : null
  const effectiveLoading   = address ? isLoading  : false

  return { formatted: effectiveFormatted, isLoading: effectiveLoading }
}
