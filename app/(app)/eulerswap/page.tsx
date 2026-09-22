// EulerSwap. Ported from euler-dashboard/app/eulerswap, rebuilt on the kit's charts.
import type { Metadata } from 'next';
import { AreaChart, BarChart } from '@/components/charts';
import { PageHeader } from '@/components/page-header';
import { Panel, StatRow } from '@/components/page-parts';
import { loadSwap } from '@/lib/euler-pages';
import { usd } from '@/lib/format';

// Rendered per request, not prerendered at build: see the note in app/(app)/page.tsx.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'EulerSwap',
  description: "EulerSwap's volume and fees since inception, by month and by chain.",
};

export default async function EulerSwapPage() {
  const d = await loadSwap();

  // A venue that has stopped trading is the finding. Say it in the answer line rather than
  // leaving the reader to work it out from a chart that flatlines.
  const answer =
    d.dormantMonths !== null && d.dormantMonths >= 2 ? (
      <>
        EulerSwap has not traded a month above $1M for {d.dormantMonths} months. Peak was{' '}
        {usd(d.peakVolume)} in {d.peakLabel}, against {usd(d.latestMonthVolume)} in {d.latestMonthLabel}.
      </>
    ) : (
      <>
        Peak monthly volume was {usd(d.peakVolume)} in {d.peakLabel}; the latest month is{' '}
        {usd(d.latestMonthVolume)}, as of {d.asOf}.
      </>
    );

  return (
    <>
      <PageHeader eyebrow="EulerSwap" question="Is EulerSwap still trading?" answer={answer} />

      <StatRow stats={d.stats} />

      <div className="px-4 lg:px-6">
        <Panel
          title="Monthly volume"
          caption="Volume per calendar month since inception. A venue's health reads off the recent months, not the all-time total, which only ever goes up."
          footnote={
            d.dormantMonths !== null && d.dormantMonths >= 2
              ? `No month above $1M in the last ${d.dormantMonths}. The all-time figure is history, not activity.`
              : undefined
          }
        >
          <BarChart data={d.monthlyVolume} x="name" series={[{ key: 'volume', label: 'Volume' }]} unit="usd" height={280} />
        </Panel>
      </div>

      <div className="grid gap-4 px-4 lg:grid-cols-2 lg:px-6">
        <Panel
          title="Monthly fees"
          caption="Fees follow volume, so this is the same shape in smaller numbers. Worth showing separately because fees are what the protocol actually receives."
        >
          <BarChart data={d.monthlyFees} x="name" series={[{ key: 'fees', label: 'Fees' }]} unit="usd" height={260} />
        </Panel>

        <Panel
          title="Cumulative volume"
          caption="A running total, so it only rises. The slope is the information: a flat line here is a venue that has stopped."
        >
          <AreaChart data={d.cumulative} x="day" series={[{ key: 'cumulative', label: 'Cumulative' }]} unit="usd" height={260} />
        </Panel>
      </div>

      {d.byChain.series.length ? (
        <div className="px-4 lg:px-6">
          <Panel
            title="Volume by chain"
            caption="Daily volume split across the chains EulerSwap was deployed to. Only chains that ever traded are shown; a listed-but-idle chain tells you nothing."
          >
            <AreaChart data={d.byChain.rows} x="day" series={d.byChain.series} stacked unit="usd" height={280} legend />
          </Panel>
        </div>
      ) : null}
    </>
  );
}
