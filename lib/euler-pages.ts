/**
 * Loaders for Euler's three ported pages, from euler-dashboard/lib/pages.ts.
 *
 * One file mirroring the source repo's own `lib/pages.ts`, where all three live together.
 * Numbers and definitions are unchanged; shapes are reworked for the kit's charts, which take
 * `Row[]` plus `Series[]` and key their x axis on a date string rather than a unix timestamp.
 */

import { cache } from 'react';
import { getAssetBook } from './euler/euler-assets';
import { getVaultBook } from './euler/euler-vaults';
import { getEulerSwap } from './euler/euler-swap';
import { getEulerToken } from './euler/euler-token';
import type { Row } from '@/components/charts';

export interface Stat {
  label: string;
  value: number | null;
  unit: 'usd' | 'pct' | 'count' | 'price';
  caption: string;
}

const isoDay = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

/** `{ t, ...keys }` rows re-keyed on a date string, which is what the kit's charts expect. */
const toRows = (rows: Array<Record<string, unknown>> | undefined): Row[] =>
  (rows ?? []).map((r) => ({ ...(r as Row), day: isoDay(Number(r.t)) }));

// ─── Loan book ────────────────────────────────────────────────────────────

export interface BookPage {
  asOf: string;
  stats: Stat[];
  /** Per-asset supplied against borrowed, largest first. */
  assetPairs: Array<Row & { name: string; supplied: number; borrowed: number }>;
  /** Supplied but effectively never borrowed: collateral the book carries for free. */
  collateralOnly: Array<Row & { name: string; supplied: number }>;
  suppliedHistory: { series: Array<{ key: string; label: string }>; rows: Row[] };
  borrowedHistory: { series: Array<{ key: string; label: string }>; rows: Row[] };
  concentration: { supplyTop5: number; borrowTop5: number };
  topVaults: Array<Row & { name: string; supplied: number }>;
  vaultUtilization: Array<Row & { name: string; utilization: number }>;
  borrowRates: Array<Row & { name: string; rate: number }>;
}

export const loadBook = cache(async (): Promise<BookPage> => {
  const [assets, vaults] = await Promise.all([getAssetBook(), getVaultBook().catch(() => null)]);

  // Rank on whichever side an asset is larger, so a pure-collateral asset and a pure-debt asset
  // both make the cut. Ranking on supplied alone would hide the borrow-heavy ones entirely.
  const ranked = [...assets.rows].sort(
    (a, b) => Math.max(b.supplied, b.borrowed) - Math.max(a.supplied, a.borrowed),
  );

  const liveVaults = (vaults?.vaults ?? []).filter((v) => v.supplied > 0);

  return {
    asOf: isoDay(Math.floor(Date.now() / 1000)),
    stats: [
      { label: 'Supplied', value: assets.totals.supplied, unit: 'usd', caption: 'Gross, across every chain' },
      { label: 'Borrowed', value: assets.totals.borrowed, unit: 'usd', caption: 'Outstanding debt' },
      {
        label: 'Top 5 share of supply',
        value: assets.concentration.supplyTop5,
        unit: 'pct',
        caption: 'How concentrated the collateral is',
      },
      {
        label: 'Top 5 share of debt',
        value: assets.concentration.borrowTop5,
        unit: 'pct',
        caption: 'How concentrated the borrowing is',
      },
    ],
    assetPairs: ranked.slice(0, 12).map((a) => ({ name: a.symbol, supplied: a.supplied, borrowed: a.borrowed })),
    // A vault kit lists whatever anyone deploys, so plenty of assets are supplied with no real
    // borrow market against them. That is a fact about Euler's shape, not a data gap.
    collateralOnly: ranked
      .filter((a) => a.supplied > 0 && a.borrowed / a.supplied < 0.01)
      .slice(0, 10)
      .map((a) => ({ name: a.symbol, supplied: a.supplied })),
    suppliedHistory: {
      series: assets.suppliedHistory.keys.map((k) => ({ key: k, label: k })),
      rows: toRows(assets.suppliedHistory.rows as Array<Record<string, unknown>>),
    },
    borrowedHistory: {
      series: assets.borrowedHistory.keys.map((k) => ({ key: k, label: k })),
      rows: toRows(assets.borrowedHistory.rows as Array<Record<string, unknown>>),
    },
    concentration: assets.concentration,
    topVaults: [...liveVaults]
      .sort((a, b) => b.supplied - a.supplied)
      .slice(0, 12)
      .map((v) => ({ name: v.shortName || v.symbol, supplied: v.supplied })),
    vaultUtilization: [...liveVaults]
      .filter((v) => v.borrowed > 0)
      .sort((a, b) => b.utilization - a.utilization)
      .slice(0, 12)
      .map((v) => ({ name: v.shortName || v.symbol, utilization: v.utilization })),
    borrowRates: [...liveVaults]
      .filter((v) => (v.borrowApy ?? 0) > 0 && v.borrowed > 0)
      .sort((a, b) => (b.borrowApy ?? 0) - (a.borrowApy ?? 0))
      .slice(0, 12)
      .map((v) => ({ name: v.shortName || v.symbol, rate: v.borrowApy ?? 0 })),
  };
});

// ─── EulerSwap ────────────────────────────────────────────────────────────

export interface SwapPage {
  asOf: string;
  stats: Stat[];
  monthlyVolume: Array<Row & { name: string; volume: number }>;
  monthlyFees: Array<Row & { name: string; fees: number }>;
  byChain: { series: Array<{ key: string; label: string }>; rows: Row[] };
  cumulative: Row[];
  peakLabel: string | null;
  peakVolume: number;
  latestMonthLabel: string | null;
  latestMonthVolume: number;
  /** Months since the venue last traded meaningfully. Null when it is still active. */
  dormantMonths: number | null;
}

export const loadSwap = cache(async (): Promise<SwapPage> => {
  const s = await getEulerSwap();
  const months = s.months ?? [];
  const latest = months.at(-1) ?? null;
  const peak = [...months].sort((a, b) => b.volume - a.volume)[0] ?? null;

  // How long since the venue did real volume. Stated rather than left for the reader to infer
  // from a flat chart: a dormant product is the finding, not a rendering problem.
  const ACTIVE_FLOOR = 1_000_000;
  let dormantMonths: number | null = null;
  for (let i = months.length - 1; i >= 0; i--) {
    if (months[i].volume >= ACTIVE_FLOOR) {
      dormantMonths = months.length - 1 - i;
      break;
    }
  }

  return {
    asOf: isoDay(Math.floor(Date.now() / 1000)),
    stats: [
      { label: 'Volume, all time', value: s.volumeAllTime ?? 0, unit: 'usd', caption: 'Since inception' },
      { label: 'Fees, all time', value: s.feesAllTime ?? 0, unit: 'usd', caption: 'Since inception' },
      { label: 'Peak month', value: peak?.volume ?? 0, unit: 'usd', caption: peak ? peak.label : 'No months yet' },
      { label: 'Latest month', value: latest?.volume ?? 0, unit: 'usd', caption: latest ? latest.label : 'No months yet' },
    ],
    monthlyVolume: months.map((m) => ({ name: m.label, volume: m.volume })),
    monthlyFees: months.map((m) => ({ name: m.label, fees: m.fees })),
    byChain: {
      series: (s.chains ?? []).map((c) => ({ key: c.key, label: c.label })),
      rows: toRows(s.byChainDaily as Array<Record<string, unknown>>),
    },
    cumulative: toRows(s.cumulativeDaily as Array<Record<string, unknown>>),
    peakLabel: peak?.label ?? null,
    peakVolume: peak?.volume ?? 0,
    latestMonthLabel: latest?.label ?? null,
    latestMonthVolume: latest?.volume ?? 0,
    dormantMonths,
  };
});

// ─── EUL ──────────────────────────────────────────────────────────────────

export interface EulPage {
  asOf: string;
  stats: Stat[];
  priceSeries: Row[];
  /** Monthly gross fees split into the supply side's share and the protocol's. */
  monthlySplit: Array<Row & { name: string; supplySide: number; protocol: number }>;
  takeRateSeries: Row[];
  takeRate30d: number;
  takeRatePeak: { value: number; label: string } | null;
  price: number | null;
  pricePeak: { price: number; t: number } | null;
}

export const loadEul = cache(async (): Promise<EulPage> => {
  const t = await getEulerToken();
  const months = t.months ?? [];

  return {
    asOf: isoDay(Math.floor(Date.now() / 1000)),
    stats: [
      { label: 'EUL price', value: t.price, unit: 'price', caption: 'Spot' },
      { label: 'Fees, 30d', value: t.fees30d, unit: 'usd', caption: 'Gross, paid by borrowers' },
      { label: 'Revenue, 30d', value: t.revenue30d, unit: 'usd', caption: "The protocol's own share" },
      { label: 'Take rate, 30d', value: t.takeRate30d, unit: 'pct', caption: 'Revenue over gross fees' },
    ],
    priceSeries: (t.priceSeries ?? []).map((p) => ({ day: isoDay(Number(p.t)), price: Number(p.price ?? 0) })),
    // Gross fees split into who kept what. The supply side is the remainder, so it can never be
    // negative even if a month's revenue is revised above its fees.
    monthlySplit: months.map((m) => ({
      name: m.label,
      supplySide: Math.max(0, m.fees - m.revenue),
      protocol: m.revenue,
    })),
    takeRateSeries: months
      .filter((m) => m.takeRate !== null)
      .map((m) => ({ day: isoDay(Number(m.t)), takeRate: Number(m.takeRate) })),
    takeRate30d: t.takeRate30d,
    takeRatePeak: t.takeRatePeak,
    price: t.price,
    pricePeak: t.pricePeak,
  };
});
