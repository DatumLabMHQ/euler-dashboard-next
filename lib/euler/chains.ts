/**
 * Chain display registry. The chain set is read DYNAMICALLY from DefiLlama, so
 * a new Euler deployment shows up on its own. This map only supplies a stable
 * label, colour and sort order for the chains we already know about; anything
 * else renders with a fallback colour at the end of the order.
 *
 * Ordering is by current size so the stacked areas read top-down sensibly.
 */

interface ChainMeta {
  label: string
  color: string
  /** Sort order (lower = first). */
  order: number
}

const CHAIN_META: Record<string, ChainMeta> = {
  Ethereum: { label: "Ethereum", color: "var(--chart-4)", order: 1 },
  Monad: { label: "Monad", color: "var(--chart-1)", order: 2 },
  Plasma: { label: "Plasma", color: "var(--chart-2)", order: 3 },
  Avalanche: { label: "Avalanche", color: "var(--chart-3)", order: 4 },
  Base: { label: "Base", color: "var(--chart-6)", order: 5 },
  Sonic: { label: "Sonic", color: "var(--chart-5)", order: 6 },
  Binance: { label: "BNB Chain", color: "var(--chart-7)", order: 7 },
  BOB: { label: "BOB", color: "var(--chart-8)", order: 8 },
  "Hyperliquid L1": { label: "Hyperliquid", color: "var(--accent-purple)", order: 9 },
  Unichain: { label: "Unichain", color: "var(--accent-cyan)", order: 10 },
  Arbitrum: { label: "Arbitrum", color: "var(--accent-blue)", order: 11 },
  Linea: { label: "Linea", color: "var(--accent-orange)", order: 12 },
  Berachain: { label: "Berachain", color: "var(--accent-yellow)", order: 13 },
  TAC: { label: "TAC", color: "var(--accent-green)", order: 14 },
  Swellchain: { label: "Swellchain", color: "var(--text-secondary)", order: 15 },
  Mantle: { label: "Mantle", color: "var(--text-muted)", order: 16 },
}

/**
 * DefiLlama is not internally consistent about chain naming: the TVL feed uses
 * "Binance" where the fees feed uses "BSC". Normalise onto the TVL spelling so
 * per-chain revenue joins onto per-chain balances.
 */
const CHAIN_ALIASES: Record<string, string> = {
  BSC: "Binance",
  "BNB Chain": "Binance",
  "Hyperliquid L1": "Hyperliquid L1",
  Hyperliquid: "Hyperliquid L1",
}

export function normalizeChain(key: string): string {
  return CHAIN_ALIASES[key] ?? key
}

export function chainLabel(key: string): string {
  return CHAIN_META[normalizeChain(key)]?.label ?? key
}

export function chainColor(key: string, fallbackIndex = 0): string {
  const palette = ["var(--text-muted)", "var(--text-secondary)", "var(--accent-purple)", "var(--accent-cyan)"]
  return CHAIN_META[normalizeChain(key)]?.color ?? palette[fallbackIndex % palette.length]
}

export function chainOrder(key: string): number {
  return CHAIN_META[normalizeChain(key)]?.order ?? 100
}
