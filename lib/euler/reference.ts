/**
 * Static reference facts for the Euler terminal - protocol metadata, external
 * links, and DefiLlama slugs. Keeping these in one place makes the data libs
 * config-driven: adding a chain or a peer is a config change, not code.
 */

export const SITE = {
  url: "https://euler-dashboard.vercel.app",
  handle: "@datumlabss",
  credit: "Datum Labs",
} as const

export const PROTOCOL = {
  name: "Euler",
  version: "V2",
  by: "Euler Labs",
  app: "https://app.euler.finance",
  docs: "https://docs.euler.finance",
  defillama: "https://defillama.com/protocol/euler-v2",
} as const

/**
 * DefiLlama slugs. `euler-v2` carries the lending book (TVL, per-chain splits,
 * per-token supply and borrow history, fees and revenue). `eulerswap` is the
 * separate DEX adapter. `euler-v1` and `eulerdebt` are both under $30K and are
 * deliberately not tracked.
 */
export const LLAMA_SLUGS = {
  lending: "euler-v2",
  dex: "eulerswap",
  /** Yields-API `project` name for Euler's EVK vaults. */
  yieldProject: "euler-v2",
} as const

/** EUL governance token (Ethereum). Used for the price feed. */
export const EUL = {
  address: "0xd9fcd98c322942075a5c3860693e9f4f03aae07b",
  coinKey: "ethereum:0xd9fcd98c322942075a5c3860693e9f4f03aae07b",
  symbol: "EUL",
  decimals: 18,
} as const

/**
 * Lending peers for the position charts. Slug is the DefiLlama protocol; the
 * peer set is the open money-market comparison Euler is usually measured
 * against. `euler-v2` is the subject and renders in accent.
 */
export const PEERS: Array<{ slug: string; label: string; subject?: boolean }> = [
  { slug: "aave-v3", label: "Aave V3" },
  { slug: "morpho-blue", label: "Morpho" },
  { slug: "sparklend", label: "Spark" },
  { slug: "compound-v3", label: "Compound V3" },
  { slug: "fluid-lending", label: "Fluid" },
  { slug: "euler-v2", label: "Euler V2", subject: true },
]
