// EUL. Ported from euler-dashboard/app/eul, rebuilt on the kit's charts.
import type { Metadata } from 'next';
import { AreaChart, BarChart, LineChart } from '@/components/charts';
import { PageHeader } from '@/components/page-header';
import { Panel, StatRow } from '@/components/page-parts';
import { loadEul } from '@/lib/euler-pages';
import { pct } from '@/lib/format';

// Rendered per request, not prerendered at build: see the note in app/(app)/page.tsx.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'EUL',
  description: 'What the protocol keeps from gross fees, how that take rate has moved, and where EUL trades against its peak.',
};

export default async function EulPage() {
  const d = await loadEul();
  const drawdown =
    d.price && d.pricePeak && d.pricePeak.price > 0 ? (d.price / d.pricePeak.price - 1) * 100 : null;

  return (
    <>
      <PageHeader
        eyebrow="EUL"
        question="What does the protocol keep?"
        answer={
          <>
            Euler keeps {pct(d.takeRate30d, 1)} of gross fees as revenue over the last thirty days
            {d.takeRatePeak ? <>, against a peak of {pct(d.takeRatePeak.value, 1)} in {d.takeRatePeak.label}</> : null}
            {drawdown !== null ? <>. EUL trades {pct(drawdown, 1)} against its own peak</> : null}, as of {d.asOf}.
          </>
        }
      />

      <StatRow stats={d.stats} />

      <div className="px-4 lg:px-6">
        <Panel
          title="Gross fees split by who keeps them"
          caption={
            <>
              <b className="font-medium text-foreground">Borrowers pay one number; two parties split it.</b> The
              supply side takes the bulk as interest, the protocol keeps the rest. Stacked so the total bar is
              what borrowers actually paid that month.
            </>
          }
        >
          <BarChart
            data={d.monthlySplit}
            x="name"
            series={[
              { key: 'supplySide', label: 'Supply side' },
              { key: 'protocol', label: 'Protocol' },
            ]}
            stacked
            unit="usd"
            height={300}
            legend
          />
        </Panel>
      </div>

      <div className="grid gap-4 px-4 lg:grid-cols-2 lg:px-6">
        <Panel
          title="Take rate over time"
          caption="Protocol revenue as a share of gross fees, by month. Months with too little fee volume for the ratio to mean anything are left out rather than plotted as noise."
          footnote={
            d.takeRatePeak
              ? `Peak take rate ${pct(d.takeRatePeak.value, 1)} in ${d.takeRatePeak.label}; ${pct(d.takeRate30d, 1)} over the last thirty days.`
              : undefined
          }
        >
          <AreaChart data={d.takeRateSeries} x="day" series={[{ key: 'takeRate', label: 'Take rate' }]} unit="pct" height={260} />
        </Panel>

        <Panel
          title="EUL price"
          caption="Price last, deliberately. It says little about the protocol on its own; read it against the take rate beside it."
          footnote={
            d.pricePeak
              ? `Peak $${d.pricePeak.price.toFixed(2)} on ${new Date(d.pricePeak.t * 1000).toISOString().slice(0, 10)}.`
              : undefined
          }
        >
          <LineChart data={d.priceSeries} x="day" series={[{ key: 'price', label: 'Price' }]} unit="usd" height={260} zero={false} />
        </Panel>
      </div>
    </>
  );
}
