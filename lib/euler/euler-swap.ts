/**
 * EulerSwap: Euler's AMM, where liquidity is sourced just-in-time from Euler
 * lending vaults rather than sitting in a pool. That design means the venue has
 * no TVL of its own on DefiLlama, so volume and fees are the only measures.
 *
 * The honest finding this module exists to carry: EulerSwap ran roughly $0.5B
 * to $1.1B a month from June to October 2025, then fell away almost entirely.
 * That is not a rounding artefact, it is the shape of the data, and it is
 * reported as-is rather than smoothed or omitted.
 *
 * Caveat kept with the data: DefiLlama still lists the adapter as live across
 * four chains, so this reads as the venue going quiet rather than an indexing
 * break. It cannot be fully ruled out from the public feed alone.
 */
import { ttlMemo, TTL_5MIN } from "./cache"
import { fetchJson } from "./fetch-json"
import { LLAMA_SLUGS } from "./reference"

const LLAMA = "https://api.llama.fi"

export interface DayPoint {
  t: number
  [key: string]: number | null
}

export interface MonthPoint {
  label: string
  t: number
  volume: number
  fees: number
}

export interface SwapChainSeries {
  key: string
  label: string
  color: string
}

export interface SwapData {
  /** Daily volume, all chains. */
  volumeDaily: DayPoint[]
  /** Daily volume split by chain, only chains that ever traded. */
  byChainDaily: DayPoint[]
  chains: SwapChainSeries[]
  /** Daily fees, all chains. */
  feesDaily: DayPoint[]
  /** Cumulative volume since inception. */
  cumulativeDaily: DayPoint[]
  months: MonthPoint[]
  volume24h: number
  volume30d: number
  volumeAllTime: number
  fees30d: number
  feesAllTime: number
  /** Largest calendar month of volume. */
  peakMonth: MonthPoint | null
  /** Last completed month as a share of the peak month, percent. */
  shareOfPeak: number
  /** Chains DefiLlama lists for the adapter, including ones that never traded. */
  listedChains: string[]
  /** Chains with any recorded volume at all. */
  activeChains: string[]
  firstDay: number
  lastDay: number
}

interface SummaryResp {
  total24h?: number
  total30d?: number
  totalAllTime?: number
  chains?: string[]
  totalDataChart?: Array<[number, number]>
  totalDataChartBreakdown?: Array<[number, Record<string, Record<string, number> | number>]>
}

const CHAIN_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"]

/** DefiLlama nests breakdown values as {chain: {product: number}}; flatten. */
function flatten(v: Record<string, number> | number): number {
  if (typeof v === "number") return v
  let s = 0
  for (const x of Object.values(v)) if (typeof x === "number") s += x
  return s
}

function monthKey(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 7)
}

function monthLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" })
}

async function build(): Promise<SwapData> {
  const [vol, fees] = await Promise.all([
    fetchJson<SummaryResp>(`${LLAMA}/summary/dexs/${LLAMA_SLUGS.dex}`),
    fetchJson<SummaryResp>(`${LLAMA}/summary/fees/${LLAMA_SLUGS.dex}?dataType=dailyFees`),
  ])
  if (!vol?.totalDataChart?.length) throw new Error("getEulerSwap: no volume series")

  const volumeDaily: DayPoint[] = vol.totalDataChart.map(([t, v]) => ({ t, volume: v }))
  const feesDaily: DayPoint[] = (fees?.totalDataChart ?? []).map(([t, v]) => ({ t, fees: v }))

  // Per-chain daily, dropping chains the adapter lists but that never traded.
  const perChain = new Map<string, Map<number, number>>()
  for (const [t, byChain] of vol.totalDataChartBreakdown ?? []) {
    for (const [chain, v] of Object.entries(byChain)) {
      if (!perChain.has(chain)) perChain.set(chain, new Map())
      perChain.get(chain)!.set(t, flatten(v))
    }
  }
  const activeChains = [...perChain.entries()]
    .filter(([, m]) => [...m.values()].some((v) => v > 0))
    .map(([c]) => c)
    .sort((a, b) => {
      const sum = (c: string) => [...(perChain.get(c)?.values() ?? [])].reduce((s, v) => s + v, 0)
      return sum(b) - sum(a)
    })
  const chains: SwapChainSeries[] = activeChains.map((c, i) => ({
    key: c,
    label: c,
    color: CHAIN_COLORS[i % CHAIN_COLORS.length],
  }))
  const byChainDaily: DayPoint[] = volumeDaily.map((row) => {
    const out: DayPoint = { t: row.t }
    for (const c of activeChains) out[c] = perChain.get(c)?.get(row.t) ?? 0
    return out
  })

  let running = 0
  const cumulativeDaily: DayPoint[] = volumeDaily.map((row) => {
    running += row.volume ?? 0
    return { t: row.t, cumulative: running }
  })

  // Calendar months. The in-progress month is kept, because on a venue this
  // quiet dropping it would hide the current state rather than clean it up.
  const byMonth = new Map<string, MonthPoint>()
  const touch = (t: number): MonthPoint => {
    const k = monthKey(t)
    let m = byMonth.get(k)
    if (!m) {
      const d = new Date(t * 1000)
      const start = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000)
      m = { label: monthLabel(start), t: start, volume: 0, fees: 0 }
      byMonth.set(k, m)
    }
    return m
  }
  for (const r of volumeDaily) touch(r.t).volume += r.volume ?? 0
  for (const r of feesDaily) touch(r.t).fees += r.fees ?? 0
  const months = [...byMonth.values()].sort((a, b) => a.t - b.t)

  const peakMonth = months.reduce<MonthPoint | null>(
    (best, m) => (best == null || m.volume > best.volume ? m : best),
    null,
  )
  const volume30d = volumeDaily.slice(-30).reduce((s, r) => s + (r.volume ?? 0), 0)
  const latestFullMonth = months.length > 1 ? months[months.length - 2] : months[0]

  return {
    volumeDaily,
    byChainDaily,
    chains,
    feesDaily,
    cumulativeDaily,
    months,
    volume24h: vol.total24h ?? 0,
    volume30d,
    volumeAllTime: vol.totalAllTime ?? running,
    fees30d: feesDaily.slice(-30).reduce((s, r) => s + (r.fees ?? 0), 0),
    feesAllTime: fees?.totalAllTime ?? 0,
    peakMonth,
    shareOfPeak:
      peakMonth && peakMonth.volume > 0 && latestFullMonth
        ? (latestFullMonth.volume / peakMonth.volume) * 100
        : 0,
    listedChains: vol.chains ?? [],
    activeChains,
    firstDay: volumeDaily[0]?.t ?? 0,
    lastDay: volumeDaily.at(-1)?.t ?? 0,
  }
}

export const getEulerSwap = ttlMemo(build, TTL_5MIN)
