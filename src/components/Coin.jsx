/** A GetCoin: disco âmbar cunhado com anel interno e raio. Mesma moeda na home e no dashboard. */
export default function Coin({ size = 40, className = '' }) {
  return (
    <svg className={`coin ${className}`} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="31" fill="#b9551a" />
      <circle cx="32" cy="32" r="28" fill="#eaad53" />
      <circle cx="32" cy="32" r="21.5" fill="none" stroke="#6e2d0b" strokeWidth="1.6" />
      <path d="M36 15.5 23.5 35.5h8.6L29 49.5l12.8-21h-8.8z" fill="none" stroke="#4f1f06" strokeWidth="2.2" strokeLinejoin="round" />
    </svg>
  )
}
