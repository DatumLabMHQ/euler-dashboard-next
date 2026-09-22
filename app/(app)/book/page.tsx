// The loan book. Ported from euler-dashboard/app/markets, rebuilt on the kit's charts.
//
// Named /book rather than /markets because this app already has a /markets page: the kit's
// sortable vault table. This is the charted read of the same book, asset by asset.
import type { Metadata } from 'next';
import { AreaChart, BarChart } from '@/components/charts';
import { PageHeader } from '@/components/page-header';
import { Panel, StatRow } from '@/components/page-parts';
import { loadBook } from '@/lib/euler-pages';
import { pct, usd } from '@/lib/format';

// Rendered per request, not prerendered at build: see the note in app/(app)/page.tsx.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Loan book',
  description: 'What gets supplied to Euler, what actually gets borrowed against it, and how concentrated both sides are.',
};

export default async function BookPage() {
  const d = await loadBook();
  const utilisation = d.stats[0].value && d.stats[1].value ? (d.stats[1].value / d.stats[0].value) * 100 : 0;

  return (
    <>
      <PageHeader
        eyebrow="Loan book"
        question="What does Euler actually lend against?"
        answer={
          <>
            {pct(utilisation, 1)} of the supplied book is borrowed, and the five largest assets hold{' '}
            {pct(d.concentration.supplyTop5, 0)} of the collateral, as of {d.asOf}.
          </>
        }
      />

      <StatRow stats={d.stats} />

      <div className="px-4 lg:px-6">
        <Panel
          title="Supplied against borrowed, by asset"
          caption={
            <>
              <b className="font-medium text-foreground">Euler V2 is a vault kit, so the book is whatever anyone
              chose to deploy.</b> Reading the two sides separately shows which assets are working collateral and
              which are simply parked. Ranked on whichever side the asset is larger, so a pure-collateral asset
              and a pure-debt asset both appear.
            </>
          }
        >
          <BarChart
            data={d.assetPairs}
            x="name"
            series={[
              { key: 'supplied', label: 'Supplied' },
              { key: 'borrowed', label: 'Borrowed' },
            ]}
            horizontal
            unit="usd"
            height={340}
            categoryWidth={96}
            legend
          />
        </Panel>
      </div>

      {d.collateralOnly.length ? (
        <div className="px-4 lg:px-6">
          <Panel
            title="Supplied with no borrow market"
            caption="Assets sitting in vaults with under 1% of their value borrowed against them. On a permissionless vault kit this is expected rather than broken, but it is the part of the book earning nothing."
            footnote={`${d.collateralOnly.length} assets shown. Threshold is borrowed under 1% of supplied.`}
          >
            <BarChart
              data={d.collateralOnly}
              x="name"
              series={[{ key: 'supplied', label: 'Supplied' }]}
              horizontal
              unit="usd"
              height={280}
              categoryWidth={96}
            />
          </Panel>
        </div>
      ) : null}

      <div className="grid gap-4 px-4 lg:grid-cols-2 lg:px-6">
        <Panel
          title="Gross supplied by asset"
          caption="The collateral base over time. Composition matters more than the total: a book that is mostly one asset carries that asset's risk."
        >
          <AreaChart data={d.suppliedHistory.rows} x="day" series={d.suppliedHistory.series} stacked unit="usd" height={280} legend />
        </Panel>

        <Panel
          title="Outstanding debt by asset"
          caption="What is actually borrowed. Compared against the chart beside it, this is where real demand sits rather than parked collateral."
        >
          <AreaChart data={d.borrowedHistory.rows} x="day" series={d.borrowedHistory.series} stacked unit="usd" height={280} legend />
        </Panel>
      </div>

      <div className="grid gap-4 px-4 lg:grid-cols-2 lg:px-6">
        <Panel
          title="Largest vaults by supplied"
          caption="Where the book is concentrated at the vault level, not the asset level. One vault carrying a large share is a different risk from one asset doing so."
        >
          <BarChart data={d.topVaults} x="name" series={[{ key: 'supplied', label: 'Supplied' }]} horizontal unit="usd" height={320} categoryWidth={120} />
        </Panel>

        <Panel
          title="Utilisation by vault"
          caption="Borrowed over supplied, per vault. High utilisation means suppliers may queue to withdraw; very low means the vault is carrying collateral nobody wants to borrow."
        >
          <BarChart data={d.vaultUtilization} x="name" series={[{ key: 'utilization', label: 'Utilisation' }]} horizontal unit="pct" height={320} categoryWidth={120} />
        </Panel>
      </div>

      {d.borrowRates.length ? (
        <div className="px-4 lg:px-6">
          <Panel
            title="Borrow rates by vault"
            caption="Base borrow APY excluding reward tokens, for vaults with a real drawn balance. A rate on an empty vault is a quote, not a price."
          >
            <BarChart data={d.borrowRates} x="name" series={[{ key: 'rate', label: 'Borrow APY' }]} horizontal unit="pct" height={320} categoryWidth={120} />
          </Panel>
        </div>
      ) : null}
    </>
  );
}
