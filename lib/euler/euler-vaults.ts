/**
 * Vault-level view of Euler V2.
 *
 * Euler V2 is the Euler Vault Kit: anyone can deploy an ERC-4626 lending vault
 * and the Ethereum Vault Connector lets vaults collateralise one another. The
 * unit of analysis is therefore the vault, not the asset, and the interesting
 * questions are how hard each vault is lent out and who is curating it.
 *
 * Sources: `yields.llama.fi/pools` for the vault list and supply rates, joined
 * to `/lendBorrow` for gross supply, debt and borrow rates. DefiLlama's pool
 * `tvlUsd` is NET, so gross supply comes from `totalSupplyUsd` where available.
 *
 * CURATOR COVERAGE IS PARTIAL. DefiLlama names the curator in `poolMeta` for
 * only a minority of Euler vaults; the rest read as "EVK Vault e<SYMBOL>-<id>".
 * Everything unmatched is reported as unattributed rather than guessed, and the
 * coverage share is exposed so a reader can weigh the curator chart properly.
 * Full attribution needs an on-chain `governorAdmin()` read per vault.
 */
import { ttlMemo, TTL_5MIN } from "./cache"
import { fetchJson } from "./fetch-json"
import { getEulerPools, getLendBorrow } from "./llama-euler"

const LLAMA = "https://api.llama.fi"

export interface VaultRow {
  id: string
  chain: string
  symbol: string
  /** DefiLlama's vault label, e.g. "EVK Vault eUSDC-80" or "K3 Capital Earn WETH". */
  name: string
  /** Compact axis label. Unique per vault, unlike symbol, which repeats. */
  shortName: string
  /** Curator name where DefiLlama attributes one, otherwise null. */
  curator: string | null
  /** Gross supplied USD. */
  supplied: number
  borrowed: number
  utilization: number
  supplyApy: number | null
  borrowApy: number | null
  rewardApy: number | null
}

export interface CuratorRow {
  curator: string
  supplied: number
  vaults: number
}

export interface VaultBook {
  vaults: VaultRow[]
  curators: CuratorRow[]
  totals: { supplied: number; borrowed: number; vaults: number }
  /** Share of supplied USD sitting in a vault with a named curator, percent. */
  curatorCoverage: number
  /** Largest curator's share of the attributed total, percent. */
  topCuratorShare: number
  /** Weighted-average utilization across vaults above the dust floor. */
  avgUtilization: number
}

/** Vaults below this are dust and would drown the charts. */
const MIN_VAULT_USD = 1_000_000

interface ProtocolListEntry {
  name?: string
  category?: string
}

/**
 * Curator registry, read from DefiLlama's "Risk Curators" protocol category so
 * a newly-listed curator is matched without a code change. Names are matched as
 * a case-insensitive prefix of the vault label.
 */
async function fetchCurators(): Promise<string[]> {
  const list = await fetchJson<ProtocolListEntry[]>(`${LLAMA}/protocols`, { timeoutMs: 90_000 })
  const names = (list ?? [])
    .filter((p) => p.category === "Risk Curators" && p.name)
    .map((p) => p.name!.trim())
    // Longest first so "K3 Capital" wins over a hypothetical "K3".
    .sort((a, b) => b.length - a.length)
  if (names.length === 0) throw new Error("getCurators: no Risk Curators in the protocol list")
  return names
}

const getCurators = ttlMemo(fetchCurators, TTL_5MIN)

/**
 * Compact, unique display name. Symbol alone is not unique - Euler runs four
 * separate AUSD vaults on Monad - so charts keyed on symbol silently collide.
 * DefiLlama's own vault id ("eAUSD-16") is the natural key; curated vaults fall
 * back to the curator's first word plus the asset.
 */
function shortNameOf(label: string | null, symbol: string, curator: string | null): string {
  const l = (label ?? "").trim()
  const evk = l.match(/^EVK Vault\s+(.+)$/i)
  if (evk) return evk[1]
  if (curator) return `${curator.split(/\s+/)[0]} ${symbol}`
  return l || symbol
}

/**
 * Curator for a vault label. "EVK Vault ..." is DefiLlama's generic name and
 * carries no attribution, so it returns null rather than a guess.
 */
function matchCurator(label: string | null, registry: string[]): string | null {
  if (!label) return null
  const l = label.trim()
  if (/^EVK Vault/i.test(l)) return null
  const lower = l.toLowerCase()
  for (const name of registry) {
    if (lower.startsWith(name.toLowerCase())) return name
  }
  // A named-but-unregistered curator still tells us more than nothing: take the
  // label up to the first product word ("Earn", "Vault", or the asset symbol).
  const m = l.match(/^([A-Za-z0-9][A-Za-z0-9\s.&-]*?)\s+(Earn|Vault|Euler)\b/)
  return m ? m[1].trim() : null
}

async function build(): Promise<VaultBook> {
  const [pools, lendBorrow, registry] = await Promise.all([
    getEulerPools(),
    getLendBorrow(),
    getCurators().catch(() => [] as string[]),
  ])

  const vaults: VaultRow[] = pools
    .map((p) => {
      const lb = lendBorrow.get(p.pool)
      const curator = matchCurator(p.poolMeta, registry)
      const symbol = (p.symbol ?? "").toUpperCase()
      // Prefer the gross supply from lendBorrow; pool tvlUsd is net of debt.
      const supplied = lb?.totalSupplyUsd ?? p.tvlUsd ?? 0
      const borrowed = lb?.totalBorrowUsd ?? 0
      return {
        id: p.pool,
        chain: p.chain,
        symbol,
        name: p.poolMeta ?? `${p.symbol} vault`,
        shortName: shortNameOf(p.poolMeta, symbol, curator),
        curator,
        supplied,
        borrowed,
        utilization: supplied > 0 ? (borrowed / supplied) * 100 : 0,
        supplyApy: p.apyBase ?? null,
        borrowApy: lb?.apyBaseBorrow ?? null,
        rewardApy: p.apyReward ?? null,
      }
    })
    .filter((v) => v.supplied >= MIN_VAULT_USD)
    .sort((a, b) => b.supplied - a.supplied)

  const totalSupplied = vaults.reduce((s, v) => s + v.supplied, 0)
  const totalBorrowed = vaults.reduce((s, v) => s + v.borrowed, 0)

  const byCurator = new Map<string, CuratorRow>()
  for (const v of vaults) {
    if (!v.curator) continue
    const row = byCurator.get(v.curator) ?? { curator: v.curator, supplied: 0, vaults: 0 }
    row.supplied += v.supplied
    row.vaults += 1
    byCurator.set(v.curator, row)
  }
  const curators = [...byCurator.values()].sort((a, b) => b.supplied - a.supplied)
  const attributed = curators.reduce((s, c) => s + c.supplied, 0)

  return {
    vaults,
    curators,
    totals: { supplied: totalSupplied, borrowed: totalBorrowed, vaults: vaults.length },
    curatorCoverage: totalSupplied > 0 ? (attributed / totalSupplied) * 100 : 0,
    topCuratorShare: attributed > 0 ? ((curators[0]?.supplied ?? 0) / attributed) * 100 : 0,
    avgUtilization: totalSupplied > 0 ? (totalBorrowed / totalSupplied) * 100 : 0,
  }
}

export const getVaultBook = ttlMemo(build, TTL_5MIN)
