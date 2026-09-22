/**
 * Per-asset view of Euler's book.
 *
 * DefiLlama carries per-token USD history for both sides of every chain:
 * `chainTvls[chain].tokensInUsd` is the NET supply per token (supplied minus
 * borrowed) and `chainTvls[chain + "-borrowed"].tokensInUsd` is the debt per
 * token. Gross supplied per token = net + borrowed.
 *
 * The reason this matters on Euler specifically: the two sides of the book are
 * not the same assets. Collateral skews to structured and yield-bearing tokens
 * while the debt is overwhelmingly stablecoins, which is what a leverage venue
 * looks like from the outside. `assetSplit` measures that directly rather than
 * asserting it.
 */
import { ttlMemo, TTL_5MIN } from "./cache"
import { getEulerProtocol, type ChainEntry, type TokenPoint } from "./llama-euler"

export interface AssetRow {
  symbol: string
  /** Gross supplied USD across all chains (net + borrowed). */
  supplied: number
  /** Borrowed USD across all chains. */
  borrowed: number
  /** Borrowed / supplied for this asset, percent. */
  utilization: number
}

export interface SeriesRow {
  t: number
  [symbol: string]: number
}

export interface AssetHistory {
  keys: string[]
  rows: SeriesRow[]
}

export interface AssetBook {
  /** Current per-asset supplied and borrowed, sorted by supplied. */
  rows: AssetRow[]
  suppliedHistory: AssetHistory
  borrowedHistory: AssetHistory
  totals: { supplied: number; borrowed: number }
  /** Share of each side held by its five largest assets, percent. */
  concentration: { supplyTop5: number; borrowTop5: number }
  /**
   * Share of each side that is a major stablecoin, by the explicit list below.
   * Anything not on the list counts as long-tail, including yield-bearing and
   * structured dollar tokens, so the measure understates rather than overstates
   * how stable-heavy a side is.
   */
  stableShare: { supplied: number; borrowed: number }
  /**
   * Share of supplied USD sitting in assets with effectively no borrow market
   * (under 2% utilization). This is the leverage-venue signature measured
   * directly: capital parked to unlock a loan rather than to earn interest.
   */
  noBorrowMarketShare: number
  assetCount: number
}

const TOP_N = 10
const OTHER = "Other"

/**
 * Widely-held stablecoins, by symbol. Deliberately conservative: it covers the
 * dollars a lender would recognise without judgement calls, and excludes
 * structured or yield-bearing dollar tokens (xUSD, vUSD, syrupUSDC, PT wrappers
 * and so on) even though those also target a dollar. Used only for the
 * stable-share read, which is stated as a floor.
 */
const MAJOR_STABLES = new Set([
  "USDC", "USDT", "USDT0", "USDS", "DAI", "PYUSD", "RLUSD", "USDE", "SUSDE",
  "GHO", "FDUSD", "TUSD", "LUSD", "FRAX", "USDTB", "USD0", "AUSD", "CRVUSD",
])

/** The token map nearest to `t` at or before it; {} before the chain existed. */
function tokensAtOrBefore(rows: TokenPoint[], t: number): Record<string, number> {
  let lo = 0, hi = rows.length - 1, idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].date <= t) { idx = mid; lo = mid + 1 } else hi = mid - 1
  }
  return idx < 0 ? {} : rows[idx].tokens
}

function latest(rows: TokenPoint[] | undefined): Record<string, number> {
  return rows && rows.length ? rows[rows.length - 1].tokens : {}
}

function addInto(dst: Record<string, number>, src: Record<string, number>) {
  for (const [k, v] of Object.entries(src)) {
    if (!Number.isFinite(v) || v <= 0) continue
    const sym = k.toUpperCase()
    dst[sym] = (dst[sym] ?? 0) + v
  }
}

/** Sum of the top `n` values as a share of the whole, percent. */
function topShare(map: Record<string, number>, n: number): number {
  const vals = Object.values(map).sort((a, b) => b - a)
  const total = vals.reduce((s, v) => s + v, 0)
  if (total <= 0) return 0
  return (vals.slice(0, n).reduce((s, v) => s + v, 0) / total) * 100
}

function stableShareOf(map: Record<string, number>): number {
  let stable = 0
  let total = 0
  for (const [sym, v] of Object.entries(map)) {
    total += v
    if (MAJOR_STABLES.has(sym)) stable += v
  }
  return total > 0 ? (stable / total) * 100 : 0
}

/**
 * Weekly stacked history for one side of the book. The top `TOP_N` assets by
 * current size get their own band, everything else rolls into "Other" so no
 * value is dropped from the total.
 */
function buildHistory(
  entries: Array<{ net: ChainEntry | undefined; borrowed: ChainEntry | undefined }>,
  side: "supplied" | "borrowed",
  topKeys: string[],
  windowDays: number,
): AssetHistory {
  const top = new Set(topKeys)
  const keys = [...topKeys, OTHER]

  let latestTs = 0
  for (const e of entries) {
    const rows = e.net?.tokensInUsd ?? []
    if (rows.length) latestTs = Math.max(latestTs, rows[rows.length - 1].date)
  }
  if (!latestTs) return { keys: [], rows: [] }

  const grid: number[] = []
  for (let t = latestTs - windowDays * 86_400; t <= latestTs; t += 7 * 86_400) grid.push(t)

  const rows: SeriesRow[] = grid.map((t) => {
    const bucket: Record<string, number> = {}
    for (const k of keys) bucket[k] = 0
    for (const e of entries) {
      const netTokens = tokensAtOrBefore(e.net?.tokensInUsd ?? [], t)
      const borTokens = tokensAtOrBefore(e.borrowed?.tokensInUsd ?? [], t)
      const merged: Record<string, number> = {}
      if (side === "supplied") {
        // Gross supplied = net + borrowed, per token.
        addInto(merged, netTokens)
        addInto(merged, borTokens)
      } else {
        addInto(merged, borTokens)
      }
      for (const [sym, v] of Object.entries(merged)) {
        const key = top.has(sym) ? sym : OTHER
        bucket[key] += v
      }
    }
    return { t, ...bucket }
  })

  // Drop "Other" if nothing ever landed in it.
  const otherUsed = rows.some((r) => (r[OTHER] ?? 0) > 0)
  return { keys: otherUsed ? keys : topKeys, rows }
}

async function build(): Promise<AssetBook> {
  const proto = await getEulerProtocol()
  const ct = proto.chainTvls ?? {}
  const chainKeys = Object.keys(ct).filter((k) => !k.endsWith("-borrowed") && k !== "borrowed")
  const entries = chainKeys.map((k) => ({ net: ct[k], borrowed: ct[`${k}-borrowed`] }))

  const suppliedNow: Record<string, number> = {}
  const borrowedNow: Record<string, number> = {}
  for (const e of entries) {
    const net = latest(e.net?.tokensInUsd)
    const bor = latest(e.borrowed?.tokensInUsd)
    addInto(suppliedNow, net)
    addInto(suppliedNow, bor)
    addInto(borrowedNow, bor)
  }

  const symbols = new Set([...Object.keys(suppliedNow), ...Object.keys(borrowedNow)])
  const rows: AssetRow[] = [...symbols]
    .map((symbol) => {
      const supplied = suppliedNow[symbol] ?? 0
      const borrowed = borrowedNow[symbol] ?? 0
      return { symbol, supplied, borrowed, utilization: supplied > 0 ? (borrowed / supplied) * 100 : 0 }
    })
    .filter((r) => r.supplied > 0 || r.borrowed > 0)
    .sort((a, b) => b.supplied - a.supplied)

  const topSupplied = rows.slice(0, TOP_N).map((r) => r.symbol)
  const topBorrowed = [...rows]
    .sort((a, b) => b.borrowed - a.borrowed)
    .slice(0, TOP_N)
    .filter((r) => r.borrowed > 0)
    .map((r) => r.symbol)

  const totalSupplied = Object.values(suppliedNow).reduce((s, v) => s + v, 0)
  const idleCollateral = rows
    .filter((r) => r.utilization < 2)
    .reduce((s, r) => s + r.supplied, 0)

  return {
    rows,
    suppliedHistory: buildHistory(entries, "supplied", topSupplied, 365),
    borrowedHistory: buildHistory(entries, "borrowed", topBorrowed, 365),
    totals: {
      supplied: totalSupplied,
      borrowed: Object.values(borrowedNow).reduce((s, v) => s + v, 0),
    },
    concentration: { supplyTop5: topShare(suppliedNow, 5), borrowTop5: topShare(borrowedNow, 5) },
    stableShare: { supplied: stableShareOf(suppliedNow), borrowed: stableShareOf(borrowedNow) },
    noBorrowMarketShare: totalSupplied > 0 ? (idleCollateral / totalSupplied) * 100 : 0,
    assetCount: rows.length,
  }
}

export const getAssetBook = ttlMemo(build, TTL_5MIN)
