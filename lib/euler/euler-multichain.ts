/**
 * Euler V2 multi-chain data spine (the Overview's foundation).
 *
 * One cached pull of DefiLlama's `/protocol/euler-v2` plus the fees and revenue
 * summaries, reshaped into per-chain and aggregate daily series:
 *   deposits (gross supplied), borrows (outstanding debt), tvl (net / available
 *   liquidity), utilization (borrows / deposits), fees and revenue.
 *
 * DefiLlama's lending convention: `chainTvls[chain].tvl` is NET (supplied minus
 * borrowed) and `chainTvls[chain + "-borrowed"].tvl` is the debt, so
 * gross deposits = net + borrowed. The bare `borrowed` key is the chainless
 * roll-up and is skipped (it double-counts).
 *
 * The chain list is discovered from the response rather than hardcoded, so a
 * new Euler deployment appears on its own.
 */
import { ttlMemo, TTL_5MIN } from "./cache"
import { fetchJson } from "./fetch-json"
import { LATEST_CORRECTED } from "./euler-fees-corrected"
import { chainLabel, chainOrder, normalizeChain } from "./chains"
import { getEulerProtocol, type ChainEntry, type TvlPoint } from "./llama-euler"
import { LLAMA_SLUGS } from "./reference"

const LLAMA = "https://api.llama.fi"

export type MetricKey = "deposits" | "borrows" | "tvl" | "utilization" | "revenue"

export interface DayMetrics {
  t: number
  deposits: number
  borrows: number
  tvl: number
  utilization: number | null
  revenue: number
  fees: number
}

export interface ChainSeries {
  chain: string
  label: string
  daily: DayMetrics[]
}

export interface ChainSnapshot {
  chain: string
  label: string
  deposits: number
  tvl: number
  borrows: number
  utilization: number
  ldr: number
  fees7d: number
  /**
   * Trailing 30 days of DefiLlama's per-chain revenue. Kept for continuity, but
   * their Euler feed stopped publishing after 22 August 2026, so on any date
   * after that this is summing days that do not exist. Prefer verifiedRevenue.
   */
  revenue30d: number
  /** Per-chain revenue for the most recent month measured from the contracts. */
  verifiedRevenue: number | null
  /** Which month that is, "YYYY-MM", null when the chain was not covered. */
  verifiedMonth: string | null
  /** Constant-price net change in the deposit base over 30d (price excluded). */
  netDeposits30d: number
  /** Gross deposits 90 days ago, for the "who grew, who shrank" read. */
  deposits90dAgo: number
}

export interface MetricSnapshot {
  current: number
  change24h: number | null
  change30d: number | null
  change365d: number | null
  spark: Array<{ t: number; v: number }>
}

export type Period = "current" | "week" | "month" | "quarter"

export interface MixSnapshot {
  /** Gross supplied USD by token (net + borrowed). */
  supplied: Record<string, number>
  /** Borrowed USD by token. */
  borrowed: Record<string, number>
}
export interface ChainMix {
  chain: string
  label: string
  periods: Record<Period, MixSnapshot>
}

export type FlowWindow = "week" | "month" | "quarter"
export interface SankeyNode { name: string; kind: "in" | "chain" | "out" }
export interface SankeyLink { source: number; target: number; value: number }
export interface FlowData {
  nodes: SankeyNode[]
  links: SankeyLink[]
  netByChain: Record<string, number>
  totalIn: number
  totalOut: number
}

export interface MultiChainData {
  chains: ChainSeries[]
  aggregateDaily: DayMetrics[]
  snap: Record<MetricKey, MetricSnapshot> & { ldr: MetricSnapshot }
  perChain: ChainSnapshot[]
  mix: ChainMix[]
  flows: Record<FlowWindow, FlowData>
  /** All-time peak of aggregate gross deposits, for the drawdown read. */
  peak: { t: number; deposits: number }
  fetchedAt: number
}

const PERIOD_DAYS: Record<Period, number> = { current: 0, week: 7, month: 30, quarter: 90 }

/** Chains whose current gross deposits are below this are folded into "Other"
 *  by `groupSmallChains`. Euler has 16 deployments and 5 of them are dust. */
export const SMALL_CHAIN_USD = 2_000_000

interface FeesResp {
  totalDataChartBreakdown?: Array<[number, Record<string, Record<string, number> | number>]>
}

/**
 * Per-chain daily USD from a fees breakdown. DefiLlama nests the value as
 * `{chain: {product: number}}` rather than a plain number, so flatten. Chain
 * keys are normalised because the fees feed says "BSC" where TVL says "Binance".
 */
function byChainDaily(fees: FeesResp | null): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>()
  for (const [ts, perChain] of fees?.totalDataChartBreakdown ?? []) {
    for (const [rawChain, v] of Object.entries(perChain)) {
      const chain = normalizeChain(rawChain)
      let usd = 0
      if (typeof v === "number") usd = v
      else for (const x of Object.values(v)) if (typeof x === "number") usd += x
      if (!out.has(chain)) out.set(chain, new Map())
      const m = out.get(chain)!
      m.set(ts, (m.get(ts) ?? 0) + usd)
    }
  }
  return out
}

function buildChainDaily(
  net: TvlPoint[] | undefined,
  borrowed: TvlPoint[] | undefined,
  revByDay: Map<number, number> | undefined,
  feesByDay: Map<number, number> | undefined,
): DayMetrics[] {
  const borrowMap = new Map((borrowed ?? []).map((p) => [p.date, p.totalLiquidityUSD]))
  return (net ?? []).map((p) => {
    const tvl = p.totalLiquidityUSD
    const borrows = borrowMap.get(p.date) ?? 0
    const deposits = tvl + borrows
    return {
      t: p.date,
      deposits,
      borrows,
      tvl,
      utilization: deposits > 0 ? (borrows / deposits) * 100 : null,
      revenue: revByDay?.get(p.date) ?? 0,
      fees: feesByDay?.get(p.date) ?? 0,
    }
  })
}

/** Token USD map nearest to `daysAgo` before the latest sample. */
function tokensAt(entry: ChainEntry | undefined, daysAgo: number): Record<string, number> {
  const rows = entry?.tokensInUsd ?? []
  if (rows.length === 0) return {}
  const targetTs = rows[rows.length - 1].date - daysAgo * 86_400
  let best = rows[rows.length - 1]
  let diff = Infinity
  for (const r of rows) { const dd = Math.abs(r.date - targetTs); if (dd < diff) { diff = dd; best = r } }
  return diff <= 5 * 86_400 ? best.tokens : {}
}

function addInto(dst: Record<string, number>, src: Record<string, number>) {
  for (const [k, v] of Object.entries(src)) if (v > 0) dst[k] = (dst[k] ?? 0) + v
}

/**
 * Constant-price net flow per token for a chain over `windowDays`: the change in
 * token QUANTITY valued at today's price, so a token that only moved in price
 * contributes nothing. This separates "capital left" from "the market fell".
 */
function perTokenFlow(net: ChainEntry | undefined, windowDays: number): Record<string, number> {
  const units = net?.tokens ?? []
  const usd = net?.tokensInUsd ?? []
  if (units.length < 2 || usd.length < 2) return {}
  const usdByDate = new Map(usd.map((r) => [r.date, r.tokens]))
  const nowRow = units[units.length - 1]
  const nowUsd = usdByDate.get(nowRow.date) ?? {}
  const targetTs = nowRow.date - windowDays * 86_400
  let then = units[0]
  let diff = Infinity
  for (const r of units) { const dd = Math.abs(r.date - targetTs); if (dd < diff) { diff = dd; then = r } }
  if (diff > 5 * 86_400) return {}
  const out: Record<string, number> = {}
  for (const tk of new Set([...Object.keys(nowRow.tokens), ...Object.keys(then.tokens)])) {
    const unitsNow = nowRow.tokens[tk] ?? 0
    const priceNow = unitsNow ? (nowUsd[tk] ?? 0) / unitsNow : 0
    const flow = ((nowRow.tokens[tk] ?? 0) - (then.tokens[tk] ?? 0)) * priceNow
    if (Math.abs(flow) > 1) out[tk] = flow
  }
  return out
}

function netDepositFlow(net: ChainEntry | undefined, windowDays: number): number {
  return Object.values(perTokenFlow(net, windowDays)).reduce((s, v) => s + v, 0)
}

/** Net-supply-flow Sankey: asset inflows -> chains -> asset outflows. */
function buildFlows(
  chainsMeta: Array<{ chain: string; label: string }>,
  rawNet: Map<string, ChainEntry | undefined>,
  windowDays: number,
  topN = 10,
): FlowData {
  const triples: Array<{ chain: string; token: string; flow: number }> = []
  const inByAsset: Record<string, number> = {}
  const outByAsset: Record<string, number> = {}
  const netByChain: Record<string, number> = {}
  for (const cm of chainsMeta) {
    const flows = perTokenFlow(rawNet.get(cm.chain), windowDays)
    for (const [rawToken, flow] of Object.entries(flows)) {
      const token = rawToken.toUpperCase()
      triples.push({ chain: cm.chain, token, flow })
      netByChain[cm.chain] = (netByChain[cm.chain] ?? 0) + flow
      if (flow > 0) inByAsset[token] = (inByAsset[token] ?? 0) + flow
      else outByAsset[token] = (outByAsset[token] ?? 0) + -flow
    }
  }
  const topKeys = (m: Record<string, number>) =>
    new Set(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, topN).map(([k]) => k))
  const inTop = topKeys(inByAsset)
  const outTop = topKeys(outByAsset)
  const inName = (t: string) => (inTop.has(t) ? t : "Other")
  const outName = (t: string) => (outTop.has(t) ? t : "Other")

  const inNodes = [...inTop, ...(Object.keys(inByAsset).some((k) => !inTop.has(k)) ? ["Other"] : [])]
  const outNodes = [...outTop, ...(Object.keys(outByAsset).some((k) => !outTop.has(k)) ? ["Other"] : [])]
  const chainNodes = chainsMeta.filter((c) => (netByChain[c.chain] ?? 0) !== 0)

  const nodes: SankeyNode[] = [
    ...inNodes.map((n) => ({ name: n, kind: "in" as const })),
    ...chainNodes.map((c) => ({ name: c.label, kind: "chain" as const })),
    ...outNodes.map((n) => ({ name: n, kind: "out" as const })),
  ]
  const inIdx = new Map(inNodes.map((n, i) => [n, i]))
  const chainBase = inNodes.length
  const chainIdx = new Map(chainNodes.map((c, i) => [c.chain, chainBase + i]))
  const outBase = chainBase + chainNodes.length
  const outIdx = new Map(outNodes.map((n, i) => [n, outBase + i]))

  const linkMap = new Map<string, number>()
  for (const { chain, token, flow } of triples) {
    const ci = chainIdx.get(chain)
    if (ci == null) continue
    if (flow > 0) {
      const si = inIdx.get(inName(token))!
      linkMap.set(`${si}>${ci}`, (linkMap.get(`${si}>${ci}`) ?? 0) + flow)
    } else {
      const ti = outIdx.get(outName(token))!
      linkMap.set(`${ci}>${ti}`, (linkMap.get(`${ci}>${ti}`) ?? 0) + -flow)
    }
  }
  const links: SankeyLink[] = [...linkMap.entries()].map(([k, value]) => {
    const [s, t] = k.split(">").map(Number)
    return { source: s, target: t, value }
  })

  return {
    nodes,
    links,
    netByChain,
    totalIn: Object.values(inByAsset).reduce((s, v) => s + v, 0),
    totalOut: Object.values(outByAsset).reduce((s, v) => s + v, 0),
  }
}

function valueAt(daily: DayMetrics[], key: Exclude<MetricKey, "utilization">, daysAgo: number): number | null {
  if (daily.length === 0) return null
  const targetTs = daily[daily.length - 1].t - daysAgo * 86_400
  let best: DayMetrics | null = null
  let diff = Infinity
  for (const d of daily) {
    const dd = Math.abs(d.t - targetTs)
    if (dd < diff) { diff = dd; best = d }
  }
  if (!best || diff > 3 * 86_400) return null
  return best[key]
}

function snapOf(daily: DayMetrics[], key: Exclude<MetricKey, "utilization">): MetricSnapshot {
  const current = daily.at(-1)?.[key] ?? 0
  const d = (n: number) => {
    const past = valueAt(daily, key, n)
    return past == null ? null : current - past
  }
  return {
    current,
    change24h: d(1),
    change30d: d(30),
    change365d: d(365),
    spark: daily.slice(-30).map((x) => ({ t: x.t, v: x[key] })),
  }
}

/** Ratio snapshot (utilization / LDR); deltas are percentage points. */
function ratioSnap(daily: DayMetrics[]): MetricSnapshot {
  const ratioAt = (d: DayMetrics) => (d.deposits > 0 ? (d.borrows / d.deposits) * 100 : 0)
  const current = daily.length ? ratioAt(daily[daily.length - 1]) : 0
  const at = (n: number): number | null => {
    if (daily.length === 0) return null
    const targetTs = daily[daily.length - 1].t - n * 86_400
    let best: DayMetrics | null = null
    let diff = Infinity
    for (const x of daily) { const dd = Math.abs(x.t - targetTs); if (dd < diff) { diff = dd; best = x } }
    return best && diff <= 3 * 86_400 ? ratioAt(best) : null
  }
  const d = (n: number) => { const p = at(n); return p == null ? null : current - p }
  return {
    current,
    change24h: d(1),
    change30d: d(30),
    change365d: d(365),
    spark: daily.slice(-30).map((x) => ({ t: x.t, v: ratioAt(x) })),
  }
}

async function build(): Promise<MultiChainData> {
  const [proto, revenue, fees] = await Promise.all([
    getEulerProtocol(),
    fetchJson<FeesResp>(`${LLAMA}/summary/fees/${LLAMA_SLUGS.lending}?dataType=dailyRevenue`),
    fetchJson<FeesResp>(`${LLAMA}/summary/fees/${LLAMA_SLUGS.lending}?dataType=dailyFees`),
  ])
  const revByChain = byChainDaily(revenue)
  const feesByChain = byChainDaily(fees)
  const ct = proto?.chainTvls ?? {}

  // Discover chains: every key that is not a "-borrowed" companion and not the
  // chainless `borrowed` roll-up.
  const chainKeys = Object.keys(ct)
    .filter((k) => !k.endsWith("-borrowed") && k !== "borrowed")
    .sort((a, b) => chainOrder(a) - chainOrder(b))

  const rawNet = new Map<string, ChainEntry | undefined>()
  const rawBorrowed = new Map<string, ChainEntry | undefined>()
  const chains: ChainSeries[] = []
  for (const key of chainKeys) {
    const daily = buildChainDaily(ct[key]?.tvl, ct[`${key}-borrowed`]?.tvl, revByChain.get(key), feesByChain.get(key))
    if (!daily.length) continue
    chains.push({ chain: key, label: chainLabel(key), daily })
    rawNet.set(key, ct[key])
    rawBorrowed.set(key, ct[`${key}-borrowed`])
  }

  // Never let ttlMemo cache an empty result on a transient upstream failure -
  // throw so the loader's catch degrades and the next request retries.
  if (chains.length === 0) throw new Error("getMultiChain: no chain data (upstream fetch failed)")

  const dates = new Set<number>()
  for (const c of chains) for (const d of c.daily) dates.add(d.t)
  const sortedDates = [...dates].sort((a, b) => a - b)

  const aggregateDaily: DayMetrics[] = sortedDates.map((t) => {
    let deposits = 0, borrows = 0, tvl = 0, revenue = 0, fees = 0
    for (const c of chains) {
      // Levels forward-fill (a chain that skipped a day keeps its last balance);
      // flows count only on their exact day.
      const sorted = c.daily
      let lo = 0, hi = sorted.length - 1, idx = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (sorted[mid].t <= t) { idx = mid; lo = mid + 1 } else hi = mid - 1
      }
      if (idx < 0) continue
      const d = sorted[idx]
      deposits += d.deposits; borrows += d.borrows; tvl += d.tvl
      if (d.t === t) { revenue += d.revenue; fees += d.fees }
    }
    return { t, deposits, borrows, tvl, utilization: deposits > 0 ? (borrows / deposits) * 100 : null, revenue, fees }
  })

  const snap = {
    deposits: snapOf(aggregateDaily, "deposits"),
    borrows: snapOf(aggregateDaily, "borrows"),
    tvl: snapOf(aggregateDaily, "tvl"),
    revenue: snapOf(aggregateDaily, "revenue"),
    utilization: ratioSnap(aggregateDaily),
    ldr: ratioSnap(aggregateDaily),
  }

  const peak = aggregateDaily.reduce(
    (best, d) => (d.deposits > best.deposits ? { t: d.t, deposits: d.deposits } : best),
    { t: 0, deposits: 0 },
  )

  const perChain: ChainSnapshot[] = chains
    .map((c) => {
      const last = c.daily.at(-1)!
      const util = last.deposits > 0 ? (last.borrows / last.deposits) * 100 : 0
      const past = c.daily.length > 90 ? c.daily[c.daily.length - 91] : c.daily[0]
      return {
        chain: c.chain,
        label: c.label,
        deposits: last.deposits,
        tvl: last.tvl,
        borrows: last.borrows,
        utilization: util,
        ldr: util,
        fees7d: c.daily.slice(-7).reduce((s, d) => s + d.fees, 0),
        revenue30d: c.daily.slice(-30).reduce((s, d) => s + d.revenue, 0),
        verifiedRevenue: LATEST_CORRECTED?.perChain[c.chain]?.revenue ?? null,
        verifiedMonth: LATEST_CORRECTED?.perChain[c.chain] ? LATEST_CORRECTED.month : null,
        netDeposits30d: netDepositFlow(rawNet.get(c.chain), 30),
        deposits90dAgo: past?.deposits ?? 0,
      }
    })
    .sort((a, b) => b.deposits - a.deposits)

  const periods = Object.keys(PERIOD_DAYS) as Period[]
  const mix: ChainMix[] = chains.map((c) => {
    const net = rawNet.get(c.chain)
    const bor = rawBorrowed.get(c.chain)
    const byPeriod = {} as Record<Period, MixSnapshot>
    for (const p of periods) {
      const d = PERIOD_DAYS[p]
      const netUsd = tokensAt(net, d)
      const borrowedUsd = tokensAt(bor, d)
      const supplied: Record<string, number> = {}
      addInto(supplied, netUsd)
      addInto(supplied, borrowedUsd)
      const borrowed: Record<string, number> = {}
      addInto(borrowed, borrowedUsd)
      byPeriod[p] = { supplied, borrowed }
    }
    return { chain: c.chain, label: c.label, periods: byPeriod }
  })

  // The Sankey only reads chains with a meaningful book; dust chains add nodes
  // with no signal.
  const flowChains = perChain
    .filter((c) => c.deposits >= SMALL_CHAIN_USD)
    .map((c) => ({ chain: c.chain, label: c.label }))
  const flows: Record<FlowWindow, FlowData> = {
    week: buildFlows(flowChains, rawNet, 7),
    month: buildFlows(flowChains, rawNet, 30),
    quarter: buildFlows(flowChains, rawNet, 90),
  }

  return { chains, aggregateDaily, snap, perChain, mix, flows, peak, fetchedAt: Math.floor(Date.now() / 1000) }
}

export const getMultiChain = ttlMemo(build, TTL_5MIN)

// ─────────────────────────────────────────────────────────────────────────
// Aligned per-chain series for the stacked-area charts.
// ─────────────────────────────────────────────────────────────────────────

export interface ChainMeta { key: string; label: string }
export interface AlignedRow {
  t: number
  [chainKey: string]: number | null
}
export interface ByChainAligned {
  chains: ChainMeta[]
  series: Record<MetricKey, AlignedRow[]>
}

/** Nearest sample at or before `t` (forward fill); null before a chain exists. */
function sampleLE(daily: DayMetrics[], t: number, key: MetricKey): number | null {
  let lo = 0, hi = daily.length - 1, idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (daily[mid].t <= t) { idx = mid; lo = mid + 1 } else hi = mid - 1
  }
  if (idx < 0) return null
  const d = daily[idx]
  return key === "utilization" ? d.utilization : d[key]
}

export function buildByChain(mc: MultiChainData, windowDays = 365): ByChainAligned {
  const now = mc.aggregateDaily.at(-1)?.t ?? Math.floor(Date.now() / 1000)
  const start = now - windowDays * 86_400
  const grid: number[] = []
  for (let t = start; t <= now; t += 7 * 86_400) grid.push(t)

  const metrics: MetricKey[] = ["deposits", "borrows", "tvl", "utilization", "revenue"]
  const series = {} as Record<MetricKey, AlignedRow[]>
  for (const m of metrics) {
    series[m] = grid.map((t) => {
      const row: AlignedRow = { t }
      for (const c of mc.chains) {
        const v = sampleLE(c.daily, t, m)
        row[c.chain] = v == null ? (m === "utilization" ? null : 0) : v
      }
      return row
    })
  }
  return { chains: mc.chains.map((c) => ({ key: c.chain, label: c.label })), series }
}

/**
 * Split the chain list into the ones worth naming and a rolled-up "Other".
 * Euler runs 16 deployments and five of them hold under $2M, which would add
 * five invisible bands to every stacked area.
 */
export function groupSmallChains(mc: MultiChainData, minUsd = SMALL_CHAIN_USD): {
  named: ChainSeries[]
  smallKeys: string[]
} {
  const current = new Map(mc.perChain.map((c) => [c.chain, c.deposits]))
  const named: ChainSeries[] = []
  const smallKeys: string[] = []
  for (const c of mc.chains) {
    if ((current.get(c.chain) ?? 0) >= minUsd) named.push(c)
    else smallKeys.push(c.chain)
  }
  named.sort((a, b) => (current.get(b.chain) ?? 0) - (current.get(a.chain) ?? 0))
  return { named, smallKeys }
}
