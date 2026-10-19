/**
 * 15market logo — inline SVG, faithful to the uploaded brand asset.
 * The "15" digits are filled with the brand green (#52b36e).
 * The "market" wordmark is rendered in the current --ink-2 color so it
 * adapts correctly in both light and dark mode.
 */
export default function Logo15market({ size = 36 }: { size?: number }) {
  const h = size
  const w = Math.round(size * 2.9)   // approx aspect ratio from logo
  return (
    <svg
      width={w}
      height={h}
      viewBox="0 0 290 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="15market"
    >
      {/* "1" */}
      <rect x="8"  y="8"  width="22" height="84" rx="4" fill="#52b36e" />
      {/* "5" — top bar */}
      <rect x="40" y="8"  width="52" height="22" rx="4" fill="#52b36e" />
      {/* "5" — left vertical (top half) */}
      <rect x="40" y="8"  width="22" height="44" rx="4" fill="#52b36e" />
      {/* "5" — middle bar */}
      <rect x="40" y="42" width="52" height="20" rx="4" fill="#52b36e" />
      {/* "5" — right vertical (bottom half) */}
      <rect x="70" y="42" width="22" height="42" rx="4" fill="#52b36e" />
      {/* "5" — bottom bar */}
      <rect x="40" y="70" width="52" height="22" rx="4" fill="#52b36e" />
      {/* small arrow/tree decoration inside "5" gap — matches logo */}
      <path d="M51 58 L61 46 L71 58 L66 58 L66 62 L56 62 L56 58 Z" fill="white" opacity="0.85" />

      {/* "market" text */}
      <text
        x="104"
        y="76"
        fontFamily="'Space Grotesk', 'DM Sans', sans-serif"
        fontSize="58"
        fontWeight="400"
        letterSpacing="-1"
        fill="currentColor"
        opacity="0.55"
      >
        market
      </text>
    </svg>
  )
}
