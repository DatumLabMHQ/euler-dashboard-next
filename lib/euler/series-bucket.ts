/**
 * Time-series granularity bucketing for the W / M / Q toggles. Buckets a daily
 * series into weekly / monthly / quarterly points over the FULL history (the
 * lending-terminal convention), summing flows or averaging levels.
 */
export type Granularity = "W" | "M" | "Q"

function bucketStart(ts: number, g: Granularity): number {
  const d = new Date(ts * 1000)
  if (g === "W") {
    // Floor to a 7-day grid anchored on the UNIX epoch (a Thursday) - stable.
    return Math.floor(ts / (7 * 86_400)) * 7 * 86_400
  }
  if (g === "M") {
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000)
  }
  // Quarter.
  const q = Math.floor(d.getUTCMonth() / 3) * 3
  return Math.floor(Date.UTC(d.getUTCFullYear(), q, 1) / 1000)
}

export interface Row {
  t: number
  [key: string]: number | null
}

/**
 * Bucket multi-key rows by granularity. `sum` adds values within a bucket
 * (flows: volume, fees); `avg` averages (levels: ratios, rates).
 */
export function bucketRows(rows: Row[], keys: string[], g: Granularity, mode: "sum" | "avg"): Row[] {
  if (rows.length === 0) return rows
  const buckets = new Map<number, { sums: Record<string, number>; counts: Record<string, number> }>()
  for (const r of rows) {
    const b = bucketStart(r.t, g)
    let entry = buckets.get(b)
    if (!entry) {
      entry = { sums: {}, counts: {} }
      buckets.set(b, entry)
    }
    for (const k of keys) {
      const v = r[k]
      if (v == null || !Number.isFinite(v)) continue
      entry.sums[k] = (entry.sums[k] ?? 0) + v
      entry.counts[k] = (entry.counts[k] ?? 0) + 1
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, entry]) => {
      const row: Row = { t }
      for (const k of keys) {
        const s = entry.sums[k]
        const n = entry.counts[k]
        row[k] = s == null ? null : mode === "sum" ? s : s / (n || 1)
      }
      return row
    })
}
