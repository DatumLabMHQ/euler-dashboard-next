/**
 * EUL and the economics behind it.
 *
 * Euler splits interest four ways in DefiLlama's model: `fees` is everything
 * borrowers pay, `supplySideRevenue` is what reaches lenders and curators,
 * `protocolRevenue` is what the protocol keeps, and `holdersRevenue` is the
 * slice DefiLlama attributes to EUL buybacks. Reading all four together is the
 * only way to see how little of the interest actually reaches the token.
 *
 * Market cap is deliberately NOT shown. DefiLlama carries no gecko id for EUL
 * and there is no public circulating-supply feed to lean on, so the page shows
 * fully diluted value against the on-chain total supply and says so, rather
 * than quoting a circulating figure it cannot source.
 */
import { ttlMemo, TTL_5MIN } from "./cache"
import {
  CORRECTED_MONTHS,
  CORRECTION_META,
  LATEST_CORRECTED,
  monthKey,
} from "./euler-fees-corrected"
import { fetchJson } from "./fetch-json"
import { EUL, LLAMA_SLUGS } from "./reference"

const LLAMA = "https://api.llama.fi"
const COINS = "https://coins.llama.fi"

/** Public Ethereum RPCs, tried in order, for the EUL total-supply read. */
const RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://rpc.flashbots.net",
  "https://eth.drpc.org",
  "https://cloudflare-eth.com",
]

export interface DayPoint {
  t: number
  [key: string]: number | null
}

export interface MonthPoint {
  label: string
  t: number
  fees: number
  revenue: number
  holders: number
  takeRate: number | null
  /**
   * True when this month was measured directly from Euler's contracts. False
   * means it is DefiLlama's published figure, which overstates fees and revenue.
   * Never present the two as the same kind of number.
   */
  verified: boolean
}

export interface ChainSeriesMeta {
  key: string
  label: string
  color: string
}

export interface TokenData {
  price: number | null
  priceSeries: DayPoint[]
  /** Peak price in the available window, for the drawdown read. */
  pricePeak: { price: number; t: number } | null
  /** On-chain EUL total supply. Null when every public RPC refused. */
  totalSupply: number | null
  fullyDiluted: number | null

  /** Daily flows, all chains. */
  flows: DayPoint[]
  months: MonthPoint[]

  fees30d: number
  revenue30d: number
  feesAnnualized: number
  revenueAnnualized: number
  /** Protocol revenue as a share of fees over the last 30 days, percent. */
  takeRate30d: number
  /** Same measure at its own historical peak, for the trend read. */
  takeRatePeak: { value: number; label: string } | null

  /**
   * The most recent month measured from the contracts. Prefer these over the
   * trailing figures above, which are built from a feed that stopped publishing.
   */
  verified: {
    month: string
    fees: number
    revenue: number
    takeRate: number
    /** Accrued interest held out of the totals as uncollectible. */
    excludedBadDebtFees: number
  } | null
  /** How far the published feed diverges, and why. For the caveat in the UI. */
  correction: typeof CORRECTION_META

  holdersAllTime: number
  holdersPeakMonth: MonthPoint | null
  /** Last day EUL buybacks recorded a meaningful amount, 0 when never. */
  buybacksLastActive: number
  buybacksActive: boolean

  revenueByChain: { series: ChainSeriesMeta[]; rows: DayPoint[] }
}

interface SummaryResp {
  total30d?: number
  total1y?: number
  totalAllTime?: number
  totalDataChart?: Array<[number, number]>
  totalDataChartBreakdown?: Array<[number, Record<string, Record<string, number> | number>]>
}

interface PriceChartResp {
  coins?: Record<string, { symbol?: string; prices?: Array<{ timestamp: number; price: number }> }>
}
interface PriceNowResp {
  coins?: Record<string, { price?: number }>
}

const CHAIN_COLORS = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)",
  "var(--chart-5)", "var(--chart-6)", "var(--chart-7)", "var(--chart-8)",
]

function flatten(v: Record<string, number> | number): number {
  if (typeof v === "number") return v
  let s = 0
  for (const x of Object.values(v)) if (typeof x === "number") s += x
  return s
}

function monthStart(t: number): number {
  const d = new Date(t * 1000)
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000)
}
function monthLabel(t: number): string {
  return new Date(t * 1000).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" })
}

/**
 * EUL `totalSupply()` via a plain eth_call, trying public RPCs in order. A
 * dependency-free read is enough for one uint256 and avoids a transport that
 * treats an RPC error as a revert. Returns null if every endpoint refuses, and
 * the caller degrades the fully-diluted card rather than guessing a supply.
 */
async function readTotalSupply(): Promise<number | null> {
  for (const url of RPCS) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8_000)
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: EUL.address, data: "0x18160ddd" }, "latest"],
        }),
        cache: "no-store",
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (!res.ok) continue
      const json = (await res.json()) as { result?: string }
      const hex = json.result
      if (!hex || !/^0x[0-9a-fA-F]+$/.test(hex) || hex === "0x") continue
      const raw = BigInt(hex)
      if (raw === 0n) continue
      return Number(raw / 10n ** BigInt(EUL.decimals - 6)) / 1e6
    } catch {
      // Try the next endpoint.
    }
  }
  return null
}

async function build(): Promise<TokenData> {
  const now = Math.floor(Date.now() / 1000)
  const start = now - 400 * 86_400
  const slug = LLAMA_SLUGS.lending

  const [fees, revenue, holders, supplySide, priceNow, priceChart, totalSupply] = await Promise.all([
    fetchJson<SummaryResp>(`${LLAMA}/summary/fees/${slug}?dataType=dailyFees`),
    fetchJson<SummaryResp>(`${LLAMA}/summary/fees/${slug}?dataType=dailyRevenue`),
    fetchJson<SummaryResp>(`${LLAMA}/summary/fees/${slug}?dataType=dailyHoldersRevenue`),
    fetchJson<SummaryResp>(`${LLAMA}/summary/fees/${slug}?dataType=dailySupplySideRevenue`),
    fetchJson<PriceNowResp>(`${COINS}/prices/current/${EUL.coinKey}`),
    fetchJson<PriceChartResp>(
      `${COINS}/chart/${EUL.coinKey}?start=${start}&span=400&period=1d&searchWidth=600`,
    ),
    readTotalSupply(),
  ])
  if (!fees?.totalDataChart?.length) throw new Error("getEulerToken: no fee series")

  const feeMap = new Map(fees.totalDataChart)
  const revMap = new Map(revenue?.totalDataChart ?? [])
  const holdMap = new Map(holders?.totalDataChart ?? [])
  const supplyMap = new Map(supplySide?.totalDataChart ?? [])

  const flows: DayPoint[] = fees.totalDataChart.map(([t]) => ({
    t,
    fees: feeMap.get(t) ?? 0,
    revenue: revMap.get(t) ?? 0,
    supplySide: supplyMap.get(t) ?? 0,
    holders: holdMap.get(t) ?? 0,
  }))

  // Calendar months, with the take rate computed per month rather than per day
  // (a daily ratio is dominated by settlement timing).
  const byMonth = new Map<number, MonthPoint>()
  for (const row of flows) {
    const ms = monthStart(row.t)
    let m = byMonth.get(ms)
    if (!m) {
      m = { label: monthLabel(ms), t: ms, fees: 0, revenue: 0, holders: 0, takeRate: null, verified: false }
      byMonth.set(ms, m)
    }
    m.fees += row.fees ?? 0
    m.revenue += row.revenue ?? 0
    m.holders += row.holders ?? 0
  }
  const months = [...byMonth.values()].sort((a, b) => a.t - b.t)

  // Where a month has been rebuilt from the contracts, that measurement replaces
  // DefiLlama's. Holder revenue is left alone: EUL buy-backs come from the
  // FeeFlow controller and are not affected by the multiplier error.
  for (const m of months) {
    const fixed = CORRECTED_MONTHS[monthKey(m.t)]
    if (fixed && fixed.days >= 28) {
      m.fees = fixed.fees
      m.revenue = fixed.revenue
      m.verified = true
    }
    m.takeRate = m.fees > 0 ? (m.revenue / m.fees) * 100 : null
  }

  const trailing = (key: "fees" | "revenue", days: number) =>
    flows.slice(-days).reduce((s, r) => s + (r[key] ?? 0), 0)
  const fees30d = trailing("fees", 30)
  const revenue30d = trailing("revenue", 30)

  // Take-rate peak over months with enough fee volume for the ratio to be real.
  const rateMonths = months.filter((m) => m.fees >= 250_000 && m.takeRate != null)
  const takeRatePeak = rateMonths.reduce<{ value: number; label: string } | null>(
    (best, m) => (best == null || m.takeRate! > best.value ? { value: m.takeRate!, label: m.label } : best),
    null,
  )

  const holdersPeakMonth = months.reduce<MonthPoint | null>(
    (best, m) => (best == null || m.holders > best.holders ? m : best),
    null,
  )
  // "$1 in a month" is rounding, not a buyback: require a real daily amount.
  const activeDays = flows.filter((r) => (r.holders ?? 0) > 100)
  const buybacksLastActive = activeDays.length ? activeDays[activeDays.length - 1].t : 0
  const buybacksActive = buybacksLastActive > 0 && now - buybacksLastActive < 45 * 86_400

  const priceRows = priceChart?.coins?.[EUL.coinKey]?.prices ?? []
  const priceSeries: DayPoint[] = priceRows.map((p) => ({ t: p.timestamp, price: p.price }))
  const pricePeak = priceRows.reduce<{ price: number; t: number } | null>(
    (best, p) => (best == null || p.price > best.price ? { price: p.price, t: p.timestamp } : best),
    null,
  )
  const price = priceNow?.coins?.[EUL.coinKey]?.price ?? priceRows.at(-1)?.price ?? null

  // Revenue by chain, from the fees breakdown.
  const perChain = new Map<string, Map<number, number>>()
  for (const [t, byChain] of revenue?.totalDataChartBreakdown ?? []) {
    for (const [chain, v] of Object.entries(byChain)) {
      if (!perChain.has(chain)) perChain.set(chain, new Map())
      perChain.get(chain)!.set(t, flatten(v))
    }
  }
  const totalPerChain = (c: string) => [...(perChain.get(c)?.values() ?? [])].reduce((s, v) => s + v, 0)
  const chainKeys = [...perChain.keys()].filter((c) => totalPerChain(c) > 0).sort((a, b) => totalPerChain(b) - totalPerChain(a))
  const topChains = chainKeys.slice(0, 6)
  const series: ChainSeriesMeta[] = topChains.map((c, i) => ({ key: c, label: c, color: CHAIN_COLORS[i] }))
  const hasRest = chainKeys.length > topChains.length
  if (hasRest) series.push({ key: "Other", label: "Other chains", color: "var(--text-muted)" })
  const rows: DayPoint[] = flows.map((row) => {
    const out: DayPoint = { t: row.t }
    let other = 0
    for (const c of chainKeys) {
      const v = perChain.get(c)?.get(row.t) ?? 0
      if (topChains.includes(c)) out[c] = v
      else other += v
    }
    if (hasRest) out["Other"] = other
    return out
  })

  return {
    price,
    priceSeries,
    pricePeak,
    totalSupply,
    fullyDiluted: price != null && totalSupply != null ? price * totalSupply : null,
    flows,
    months,
    fees30d,
    revenue30d,
    feesAnnualized: (fees30d / 30) * 365,
    revenueAnnualized: (revenue30d / 30) * 365,
    takeRate30d: fees30d > 0 ? (revenue30d / fees30d) * 100 : 0,
    takeRatePeak,
    verified: LATEST_CORRECTED
      ? {
          month: LATEST_CORRECTED.month,
          fees: LATEST_CORRECTED.fees,
          revenue: LATEST_CORRECTED.revenue,
          takeRate: LATEST_CORRECTED.takeRatePct,
          excludedBadDebtFees: LATEST_CORRECTED.excludedBadDebtFees,
        }
      : null,
    correction: CORRECTION_META,
    holdersAllTime: holders?.totalAllTime ?? 0,
    holdersPeakMonth,
    buybacksLastActive,
    buybacksActive,
    revenueByChain: { series, rows },
  }
}

export const getEulerToken = ttlMemo(build, TTL_5MIN)
