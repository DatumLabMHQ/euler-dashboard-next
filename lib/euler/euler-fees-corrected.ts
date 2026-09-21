/**
 * Fee and revenue months measured directly from Euler's contracts.
 *
 * GENERATED FILE. Do not edit by hand.
 * Regenerate with: node data/export-dashboard-fees.mjs in datum-reports.
 *
 * WHY THIS EXISTS. Everything else in this dashboard reads fees from DefiLlama.
 * Their Euler adapter multiplies each vault's per-share growth by totalAssets
 * where the correct multiplier is totalSupply, so a vault's whole accumulated
 * appreciation is booked as one day of interest. Measured against the contracts
 * it overstates fees by 14.5% and revenue by 38.5%, and their feed
 * stopped publishing after 2026-08-22.
 *
 * WHAT IS NOT HERE. Only the months that have been rebuilt. Public archive nodes
 * reach roughly 100 days, so older history cannot be measured on the current
 * infrastructure. Those months are shown as published and marked unverified
 * rather than adjusted by a fudge factor.
 */

export interface CorrectedChain {
  fees: number
  revenue: number
  takeRatePct: number | null
}

export interface CorrectedMonth {
  /** Calendar month, "YYYY-MM". */
  month: string
  /** Days measured. A partial month is never published as a full one. */
  days: number
  fees: number
  revenue: number
  supplySide: number
  curatorFees: number
  takeRatePct: number
  /**
   * Interest that accrued but will never be collected, held out of the totals
   * above. interest accruing on Euler vaults caught in the Stream Finance collapse, which sit at 100% utilisation with zero cash.
   */
  excludedBadDebtFees: number
  perChain: Record<string, CorrectedChain>
}

export const CORRECTION_META = {
  "generatedFrom": "datum-reports/data/euler-fees-merged.json",
  "method": "every EVK vault read at each UTC midnight block, interest computed two independent ways and audited per chain",
  "coveredSharePct": 99.72,
  "chainsCovered": [
    "Ethereum",
    "Avalanche",
    "Base",
    "Plasma",
    "Arbitrum",
    "Berachain",
    "TAC",
    "Sonic",
    "BSC",
    "Monad"
  ],
  "chainsExcluded": [
    "BOB",
    "Unichain",
    "Linea"
  ],
  "defillamaOverstatesFeesPct": 14.5,
  "defillamaOverstatesRevenuePct": 38.5,
  "defillamaTakeRatePct": 3.18,
  "ourTakeRateSameDaysPct": 2.63,
  "feedStalledAfter": "2026-08-22",
  "excludedReason": "interest accruing on Euler vaults caught in the Stream Finance collapse, which sit at 100% utilisation with zero cash"
} as const

export const CORRECTED_MONTHS: Record<string, CorrectedMonth> = {
  "2026-08": {
    "month": "2026-08",
    "days": 31,
    "fees": 1986765,
    "revenue": 51740,
    "supplySide": 1935025,
    "curatorFees": 153012,
    "takeRatePct": 2.6042,
    "excludedBadDebtFees": 1362251,
    "perChain": {
      "Ethereum": {
        "fees": 1016161,
        "revenue": 22101,
        "takeRatePct": 2.175
      },
      "Avalanche": {
        "fees": 444918,
        "revenue": 22953,
        "takeRatePct": 5.1589
      },
      "Base": {
        "fees": 29570,
        "revenue": 0,
        "takeRatePct": 0.0007
      },
      "Plasma": {
        "fees": 25971,
        "revenue": 1213,
        "takeRatePct": 4.6704
      },
      "Arbitrum": {
        "fees": 3053,
        "revenue": 125,
        "takeRatePct": 4.1041
      },
      "Berachain": {
        "fees": 1164,
        "revenue": 0,
        "takeRatePct": 0.0076
      },
      "TAC": {
        "fees": 67,
        "revenue": 0,
        "takeRatePct": 0
      },
      "Sonic": {
        "fees": 99,
        "revenue": 0,
        "takeRatePct": 0
      },
      "BSC": {
        "fees": 8777,
        "revenue": 743,
        "takeRatePct": 8.4602
      },
      "Monad": {
        "fees": 456987,
        "revenue": 4605,
        "takeRatePct": 1.0078
      }
    }
  },
  "2026-07": {
    "month": "2026-07",
    "days": 31,
    "fees": 1938102,
    "revenue": 50567,
    "supplySide": 1887535,
    "curatorFees": 148117,
    "takeRatePct": 2.6091,
    "excludedBadDebtFees": 1254689,
    "perChain": {
      "Ethereum": {
        "fees": 1160845,
        "revenue": 21408,
        "takeRatePct": 1.8442
      },
      "Avalanche": {
        "fees": 434497,
        "revenue": 22377,
        "takeRatePct": 5.1501
      },
      "Base": {
        "fees": 39582,
        "revenue": 0,
        "takeRatePct": 0.0003
      },
      "Plasma": {
        "fees": 51737,
        "revenue": 1216,
        "takeRatePct": 2.3495
      },
      "Arbitrum": {
        "fees": 3902,
        "revenue": 213,
        "takeRatePct": 5.4535
      },
      "Berachain": {
        "fees": 1305,
        "revenue": 6,
        "takeRatePct": 0.4436
      },
      "TAC": {
        "fees": 96,
        "revenue": 0,
        "takeRatePct": 0
      },
      "Sonic": {
        "fees": 93,
        "revenue": 0,
        "takeRatePct": 0
      },
      "BSC": {
        "fees": 7395,
        "revenue": 632,
        "takeRatePct": 8.5492
      },
      "Monad": {
        "fees": 238649,
        "revenue": 4715,
        "takeRatePct": 1.9758
      }
    }
  }
}

/** UTC month key for a unix timestamp in seconds. */
export function monthKey(tSeconds: number): string {
  return new Date(tSeconds * 1000).toISOString().slice(0, 7)
}

/** The measured month for a timestamp, or null where none was rebuilt. */
export function correctedFor(tSeconds: number): CorrectedMonth | null {
  return CORRECTED_MONTHS[monthKey(tSeconds)] ?? null
}

/** Most recent measured month, which is what headline figures should use. */
export const LATEST_CORRECTED: CorrectedMonth | null =
  Object.values(CORRECTED_MONTHS).sort((a, b) => b.month.localeCompare(a.month))[0] ?? null
