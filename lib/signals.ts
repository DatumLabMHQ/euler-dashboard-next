/**
 * Signals feed — the machine-readable surface the datumlabs-alerts Worker
 * reads to detect publishable findings.
 *
 * Deliberately the same shape as fluid-dashboard/lib/signals.ts and the Spark
 * equivalent, so the Worker parses all three lending dashboards with one
 * reader and can compare them against each other without special-casing.
 *
 * The Worker does NOT re-derive these numbers from DefiLlama on its own: this
 * repo's corrections (see euler-fees-corrected.ts) are the reason the figures
 * are trustworthy, and a second derivation would silently diverge from what
 * the dashboard renders.
 */

import { getMultiChain } from "./euler/euler-multichain"
import { getVaultBook } from "./euler/euler-vaults"

/** Public page a tweet should link to, not the raw deployment host. */
const PUBLIC_BASE = "https://www.datumlab.xyz/euler-terminal"

export type SignalUnit = "usd" | "pct" | "ratio" | "count"

export interface SignalMetric {
  /** Stable id. Never rename: the Worker keys its D1 history on this. */
  key: string
  label: string
  value: number
  unit: SignalUnit
  /** True only for monotonically non-decreasing running totals. Milestone-ETA
   *  forecasting runs on these alone. */
  cumulative?: boolean
  change24h?: number | null
  change30d?: number | null
  href?: string
  /** Window the decomposition below covers, in days. */
  windowDays?: number
  /** Value at the start of that window, so the Worker need not store history. */
  prior?: number
  /**
   * What moved the aggregate. Derived here rather than in the Worker because the history
   * lives here: this dashboard has years of daily series while the Worker's store starts
   * empty, so a composition alert can fire on its first run.
   */
  components?: SignalComponent[]
}

export interface SignalComponent {
  name: string
  value: number
  prior: number
  change: number
  changePct: number | null
  /** This component's share of the aggregate's total change, in percent. */
  contributionPct: number | null
  /** Constant-price change: growth from real deposits rather than from the assets repricing. */
  realChange?: number
  /** The remainder, attributable to repricing. */
  priceEffect?: number
}

export interface SignalsPayload {
  protocol: "euler-v2"
  fetchedAt: number
  dashboardUrl: string
  metrics: SignalMetric[]
  degraded?: string[]
}

/**
 * Today's UTC day is still accumulating, so FLOW series (revenue, fees) end on
 * a partial day. `snap.revenue` is the latest DAILY value and therefore reads
 * ~0 for most of every UTC day — a rule built on it would cry collapse each
 * morning. Flows below are always summed over completed days only.
 */
function completedDays<T extends { t: number }>(pts: T[] | undefined): T[] {
  const arr = pts ?? []
  if (!arr.length) return []
  const startOfTodayUtc = Math.floor(Date.now() / 86_400_000) * 86_400
  return arr[arr.length - 1].t >= startOfTodayUtc ? arr.slice(0, -1) : arr
}

const sumField = <K extends string>(pts: Array<{ t: number } & Record<K, number>> | undefined, k: K) =>
  completedDays(pts).reduce((a, p) => a + (Number.isFinite(p[k]) ? p[k] : 0), 0)


/**
 * Split the deposit base's move over `windowDays` into per-chain contributions.
 *
 * NO PRICE SPLIT HERE, deliberately. `perChain.netDeposits30d` is a constant-price flow
 * computed by perTokenFlow() over the NET series, while the change measured here differences
 * gross `deposits`. Subtracting one basis from the other is not a price effect: on Euler it
 * implied a 60% price collapse in 30 days, which did not happen. Spark's feed does carry the
 * split because it derives both sides from one series (tokensInUsd and tokens), and that
 * version reproduces Spark's own published figure. Restore it here only by computing both
 * sides from the same series.
 */
function decomposeByChain(mc: any, windowDays: number): { value: number; prior: number; components: SignalComponent[] } | null {
  const chains: any[] = Array.isArray(mc?.chains) ? mc.chains : []
  if (!chains.length) return null

  const rows: SignalComponent[] = []
  let value = 0
  let prior = 0

  for (const c of chains) {
    const daily: any[] = Array.isArray(c.daily) ? c.daily : []
    if (daily.length < windowDays + 1) continue
    const now = daily[daily.length - 1]
    const then = daily[daily.length - 1 - windowDays]
    if (!now || !then) continue

    const nowV = Number(now.deposits) || 0
    const thenV = Number(then.deposits) || 0
    if (nowV === 0 && thenV === 0) continue
    value += nowV
    prior += thenV

    const change = nowV - thenV

    rows.push({
      name: c.label ?? c.chain,
      value: nowV,
      prior: thenV,
      change,
      changePct: thenV > 0 ? (change / thenV) * 100 : null,
      contributionPct: null,
    })
  }

  if (!rows.length) return null
  const totalChange = value - prior
  for (const r of rows) r.contributionPct = totalChange !== 0 ? (r.change / totalChange) * 100 : null
  rows.sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
  return { value, prior, components: rows }
}

export async function buildSignals(): Promise<SignalsPayload> {
  const degraded: string[] = []
  const metrics: SignalMetric[] = []

  // ── Lending book ──────────────────────────────────────────────────────────
  try {
    const mc = await getMultiChain()
    const s = mc.snap
    const push = (key: string, label: string, m: any, unit: SignalUnit = "usd", href?: string) => {
      if (!m || !Number.isFinite(m.current)) return
      metrics.push({
        key,
        label,
        value: m.current,
        unit,
        change24h: m.change24h ?? null,
        change30d: m.change30d ?? null,
        href,
      })
    }
    push("euler.lending.tvl", "Euler TVL", s.tvl, "usd", PUBLIC_BASE)
    push("euler.lending.deposits", "Euler deposits", s.deposits, "usd", `${PUBLIC_BASE}/markets`)
    push("euler.lending.borrows", "Euler borrows", s.borrows, "usd", `${PUBLIC_BASE}/markets`)
    push("euler.lending.ldr", "Euler loan-to-deposit ratio", s.ldr, "ratio", `${PUBLIC_BASE}/markets`)

    // Deposit base decomposed by chain, over two windows.
    for (const windowDays of [30, 90]) {
      const d = decomposeByChain(mc, windowDays)
      if (!d) continue
      metrics.push({
        key: "euler.lending.deposits_by_chain_" + windowDays + "d",
        label: "Euler deposits by chain",
        value: d.value,
        unit: "usd",
        windowDays,
        prior: d.prior,
        components: d.components,
        href: PUBLIC_BASE,
      })
    }

    const rev30d = sumField(mc.aggregateDaily.slice(-31), "revenue")
    if (rev30d > 0) {
      metrics.push({
        key: "euler.lending.revenue_30d",
        label: "Euler revenue, trailing 30d",
        value: rev30d,
        unit: "usd",
        href: PUBLIC_BASE,
      })
    }
    const revCum = sumField(mc.aggregateDaily, "revenue")
    if (revCum > 0) {
      metrics.push({
        key: "euler.lending.revenue_cumulative",
        label: "Euler cumulative revenue",
        value: revCum,
        unit: "usd",
        cumulative: true,
        href: PUBLIC_BASE,
      })
    }

    // Recovery-from-peak. Euler is deep in a drawdown, so the publishable
    // event is the RECOVERY crossing (back above -50%, back above -25%, or a
    // new all-time high), which nobody else is tracking as a single number.
    const peak = mc.peak?.deposits
    const cur = s.deposits?.current
    if (Number.isFinite(peak) && Number.isFinite(cur) && peak! > 0) {
      metrics.push({
        key: "euler.lending.pct_of_peak",
        label: "Euler deposits as % of all-time peak",
        value: (cur! / peak!) * 100,
        unit: "pct",
        href: `${PUBLIC_BASE}/markets`,
      })
    }
  } catch (e: any) {
    degraded.push(`multichain: ${e?.message ?? "failed"}`)
  }

  // ── Vault book / curator concentration ────────────────────────────────────
  // Concentration is a second-order read: the headline size number is public,
  // but "one curator holds N% of the attributed book" is a derivation.
  try {
    const vb = await getVaultBook()
    if (Number.isFinite(vb.totals?.supplied)) {
      metrics.push({
        key: "euler.vaults.supplied",
        label: "Euler vault supplied",
        value: vb.totals.supplied,
        unit: "usd",
        href: `${PUBLIC_BASE}/markets`,
      })
    }
    // NOTE: getVaultBook applies a $1M dust floor (MIN_VAULT_USD), so this is
    // NOT the total EVK vault count — that is in the thousands. Labelled
    // explicitly because a rule quoting this as "Euler vault count" would
    // publish a badly wrong number.
    if (Number.isFinite(vb.totals?.vaults)) {
      metrics.push({
        key: "euler.vaults.count_above_1m",
        label: "Euler vaults above $1M",
        value: vb.totals.vaults,
        unit: "count",
        href: `${PUBLIC_BASE}/markets`,
      })
    }
    if (Number.isFinite(vb.topCuratorShare)) {
      metrics.push({
        key: "euler.vaults.top_curator_share",
        label: "Euler largest curator share",
        value: vb.topCuratorShare,
        unit: "pct",
        href: `${PUBLIC_BASE}/markets`,
      })
    }
    if (Number.isFinite(vb.avgUtilization)) {
      metrics.push({
        key: "euler.vaults.avg_utilization",
        label: "Euler weighted-average vault utilisation",
        value: vb.avgUtilization,
        unit: "pct",
        href: `${PUBLIC_BASE}/markets`,
      })
    }
  } catch (e: any) {
    degraded.push(`vaults: ${e?.message ?? "failed"}`)
  }

  return {
    protocol: "euler-v2",
    fetchedAt: Math.floor(Date.now() / 1000),
    dashboardUrl: PUBLIC_BASE,
    metrics,
    ...(degraded.length ? { degraded } : {}),
  }
}
