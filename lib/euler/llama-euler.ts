/**
 * Shared, deduped access to the heavy DefiLlama payloads.
 *
 * `/protocol/euler-v2` is ~18MB and several modules need it (the chain spine,
 * the per-asset history, the composition donuts). `yields.llama.fi/pools` is
 * ~11MB and is the slowest call on the site. Each is fetched once per TTL here
 * and shared, rather than pulled independently by every module.
 */
import { ttlMemo, TTL_5MIN } from "./cache"
import { fetchJson } from "./fetch-json"
import { LLAMA_SLUGS } from "./reference"

const LLAMA = "https://api.llama.fi"
const YIELDS = "https://yields.llama.fi"

export interface TvlPoint { date: number; totalLiquidityUSD: number }
export interface TokenPoint { date: number; tokens: Record<string, number> }
export interface ChainEntry {
  tvl?: TvlPoint[]
  tokens?: TokenPoint[]
  tokensInUsd?: TokenPoint[]
}
export interface ProtocolResp {
  chainTvls?: Record<string, ChainEntry>
}

async function fetchProtocol(): Promise<ProtocolResp> {
  const r = await fetchJson<ProtocolResp>(`${LLAMA}/protocol/${LLAMA_SLUGS.lending}`, { timeoutMs: 90_000 })
  // Throw rather than return an empty shell: ttlMemo would otherwise cache the
  // failure for the full TTL and every page would show zeros for 5 minutes.
  if (!r?.chainTvls || Object.keys(r.chainTvls).length === 0) {
    throw new Error("getEulerProtocol: empty response from DefiLlama")
  }
  return r
}

export const getEulerProtocol = ttlMemo(fetchProtocol, TTL_5MIN)

/** A single lending market as the yields API sees it. */
export interface Pool {
  chain: string
  project: string
  symbol: string
  tvlUsd: number
  apyBase: number | null
  apyReward: number | null
  apy: number | null
  pool: string
  poolMeta: string | null
  stablecoin: boolean
  underlyingTokens: string[] | null
}

export interface LendBorrowRow {
  pool: string
  apyBaseBorrow: number | null
  apyRewardBorrow: number | null
  totalSupplyUsd: number | null
  totalBorrowUsd: number | null
  ltv: number | null
  borrowable: boolean | null
}

async function fetchPools(): Promise<Pool[]> {
  const r = await fetchJson<{ data?: Pool[] }>(`${YIELDS}/pools`, { timeoutMs: 90_000 })
  const rows = (r?.data ?? []).filter((p) => p.project === LLAMA_SLUGS.yieldProject)
  if (rows.length === 0) throw new Error("getEulerPools: no euler-v2 pools in the yields response")
  return rows
}

export const getEulerPools = ttlMemo(fetchPools, TTL_5MIN)

async function fetchLendBorrow(): Promise<Map<string, LendBorrowRow>> {
  const r = await fetchJson<LendBorrowRow[]>(`${YIELDS}/lendBorrow`, { timeoutMs: 90_000 })
  if (!r || r.length === 0) throw new Error("getLendBorrow: empty response")
  return new Map(r.map((row) => [row.pool, row]))
}

export const getLendBorrow = ttlMemo(fetchLendBorrow, TTL_5MIN)
