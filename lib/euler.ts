// Fills the kit's normalised shapes (lib/types.ts) from Euler's own data layer.
//
// WHY THIS DOES NOT READ THE PLATFORM
// -----------------------------------
// The kit is platform-first: lib/data.ts in the template reads datum-api and falls back to
// labelled sample data. There is no `euler` product on the platform (datum-models carries
// aave, centrifuge, morpho, ref, rwa and sui), so there is nothing to read. Rather than ship
// a dashboard on sample data, this reads the same modules the existing euler-dashboard
// renders, copied under lib/euler/.
//
// That matters beyond convenience: those modules carry hand-built fee corrections
// (lib/euler/euler-fees-corrected.ts) that DefiLlama's own feed does not have, and DefiLlama
// stopped publishing Euler revenue after 22 August 2026. Re-deriving here would quietly
// disagree with the numbers the existing terminal publishes.
//
// When a Euler product lands on the platform, this file is the only one that changes: swap the
// bodies to `query()` calls and the pages, components and tokens stay exactly as they are.

import { cache } from 'react';
import { config } from '@/datum.config';
import { getMultiChain } from './euler/euler-multichain';
import { getVaultBook } from './euler/euler-vaults';
import { getEulerProtocol } from './euler/llama-euler';
import { chainLogo, protocolLogo } from './chains';
import type { Market, MarketDetail, Overview, Point, Share } from './types';

const risk = (u: number): Market['risk'] => (u > 85 ? 'high' : u > 70 ? 'moderate' : 'safe');
const isoDay = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);
const pctChange = (now: number, then: number) => (then > 0 ? (now / then - 1) * 100 : 0);

/**
 * An EVK vault as the kit's Market. Euler vaults are single-asset, not collateral/loan pairs,
 * so the table's two labels are used honestly: the bold line is the vault (shortName is unique
 * per vault, unlike symbol which repeats), and the sub-line renders "<loan> loan", which is
 * exactly what an EVK vault lends.
 */
function toMarket(v: Awaited<ReturnType<typeof getVaultBook>>['vaults'][number]): Market {
  const util = Number.isFinite(v.utilization) ? v.utilization : 0;
  return {
    id: v.id,
    protocol: 'Euler V2',
    chain: v.chain,
    collateral: v.shortName || v.symbol,
    loan: v.symbol,
    supplied: v.supplied,
    borrowed: v.borrowed,
    utilization: util,
    supply_apy: v.supplyApy ?? 0,
    borrow_apy: v.borrowApy ?? 0,
    // EVK vaults do have an LTV configuration, but this data layer does not expose it. The kit's
    // formatters render null as "n/a", which is the truth. Printing 0% would be a false number.
    lltv: undefined as unknown as number,
    risk: risk(util),
    address: v.id,
    logos: { loan: undefined, protocol: protocolLogo('euler-v2'), chain: chainLogo(v.chain) },
  };
}

export const loadOverview = cache(async (): Promise<Overview> => {
  const [mc, book, llama] = await Promise.all([
    getMultiChain(),
    getVaultBook(),
    getEulerProtocol().catch(() => null),
  ]);

  const daily = mc.aggregateDaily;
  const last = daily[daily.length - 1];
  const asOf = last ? isoDay(last.t) : new Date().toISOString().slice(0, 10);

  // Seven-day deltas from the aggregate series rather than a stored snapshot, so the page is
  // correct on a cold start.
  const weekAgo = daily[daily.length - 8] ?? daily[0];

  const history: Point[] = daily.slice(-365).map((d) => ({
    day: isoDay(d.t),
    supply: d.deposits,
    borrow: d.borrows,
  }));

  const rates: Point[] = daily.slice(-365).map((d) => ({
    day: isoDay(d.t),
    utilization: d.utilization ?? 0,
  }));

  const byChain: Share[] = mc.perChain
    .map((c) => ({ name: c.label, value: c.deposits }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);

  // Euler is one protocol, so the second breakdown is by curator, which is the more revealing
  // cut: the largest curator carries most of the attributed book.
  const byProtocol: Share[] = book.curators
    .map((c) => ({ name: c.curator, value: c.supplied }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);

  const markets = book.vaults.map(toMarket).sort((a, b) => b.supplied - a.supplied);

  const supplied = mc.snap.deposits.current;
  const borrowed = mc.snap.borrows.current;
  // DefiLlama's own figure: the latest point of each plain chain series. Keys carrying a dash
  // ("Ethereum-borrowed", "-staking", "-pool2") are derived cuts, not chains, and double-count.
  const theirs = llama?.chainTvls
    ? Object.entries(llama.chainTvls)
        .filter(([k]) => !k.includes('-'))
        .reduce((a, [, entry]) => {
          const series = entry?.tvl;
          const point = series && series.length ? series[series.length - 1] : null;
          return a + (point?.totalLiquidityUSD ?? 0);
        }, 0)
    : 0;

  return {
    asOf,
    sample: false,
    kpis: {
      supplied,
      borrowed,
      suppliedChange7d: pctChange(supplied, weekAgo?.deposits ?? 0),
      borrowedChange7d: pctChange(borrowed, weekAgo?.borrows ?? 0),
      markets: book.totals.vaults,
      utilization: supplied > 0 ? (borrowed / supplied) * 100 : 0,
      supplyApy: book.avgUtilization > 0 ? weightedSupplyApy(book.vaults) : 0,
    },
    history,
    historyGrain: 'daily',
    rates,
    byChain,
    byProtocol,
    markets,
    reconciliation: theirs
      ? {
          ours: supplied,
          theirs,
          theirsSource: 'DefiLlama',
          note: 'Ours is gross deposits across every chain Euler is live on; DefiLlama reports net TVL, so the two differ by the borrowed balance. Their Euler revenue feed stopped publishing after 22 August 2026, which is why revenue here is measured from the contracts instead.',
        }
      : null,
  };
});

/** Supply APY weighted by supplied value, so one tiny vault at 40% cannot move the headline. */
function weightedSupplyApy(vaults: Awaited<ReturnType<typeof getVaultBook>>['vaults']): number {
  const withApy = vaults.filter((v) => v.supplyApy != null && v.supplied > 0);
  const total = withApy.reduce((a, v) => a + v.supplied, 0);
  if (total <= 0) return 0;
  return withApy.reduce((a, v) => a + (v.supplyApy as number) * v.supplied, 0) / total;
}

export const loadMarket = cache(async (id: string): Promise<MarketDetail | null> => {
  const [book, mc] = await Promise.all([getVaultBook(), getMultiChain()]);
  const vault = book.vaults.find((v) => v.id === id);
  if (!vault) return null;

  const daily = mc.aggregateDaily;
  const last = daily[daily.length - 1];
  const asOf = last ? isoDay(last.t) : new Date().toISOString().slice(0, 10);
  const market = toMarket(vault);

  return {
    asOf,
    sample: false,
    market,
    // Per-vault history is not in this data layer yet; the chart falls back to empty rather
    // than showing the protocol aggregate under a single vault's name, which would be wrong.
    history: [],
    rates: [],
    facts: [
      { label: 'Vault', value: vault.name },
      { label: 'Asset', value: vault.symbol },
      { label: 'Chain', value: vault.chain },
      { label: 'Curator', value: vault.curator ?? 'Uncurated', note: vault.curator ? undefined : 'DefiLlama attributes no curator to this vault.' },
      { label: 'Reward APY', value: vault.rewardApy != null ? `${vault.rewardApy.toFixed(2)}%` : 'n/a' },
    ],
    suppliers: [],
    healthBands: [],
  };
});

export const eulerConfig = config;
