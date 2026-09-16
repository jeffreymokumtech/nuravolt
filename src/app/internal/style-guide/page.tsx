import { Button } from '@/components/ui/button';
import { DataPanel } from '@/components/ui/DataPanel';
import { HairlineRule } from '@/components/ui/HairlineRule';
import { KPIReadout } from '@/components/ui/KPIReadout';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { Sparkline } from '@/components/ui/Sparkline';

export const metadata = {
  title: 'Internal style guide, NuraVolt',
  robots: { index: false, follow: false },
};

// Skip static prerender, Sparkline / Recharts hits `useId()` on the server
// in a way that crashes Next 14's static exporter. Internal-only page, so
// per-request SSR is fine.
export const dynamic = 'force-dynamic';

const sampleSeries = [4, 6, 5, 8, 12, 10, 11, 14, 13, 15, 18, 17, 19, 22, 21, 24, 26, 25, 28];

export default function StyleGuidePage() {
  return (
    <main className='bg-paper text-ink min-h-screen'>
      <MarketingSection size='compact'>
        <div className='max-w-3xl'>
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-2'>
            Internal · not in nav
          </div>
          <h1 className='text-h1 font-semibold tracking-tight'>NuraVolt design system</h1>
          <p className='mt-4 text-body text-ink-2 max-w-2xl'>
            Single source of truth for the marketing surface. Every primitive
            renders here; nothing on a marketing page should deviate from these
            patterns. If a section needs something not shown here, extend a
            primitive, don't style around it.
          </p>
        </div>
      </MarketingSection>

      <HairlineRule />

      <MarketingSection size='default'>
        <h2 className='text-h2 font-semibold mb-8'>Type scale</h2>
        <div className='grid gap-6'>
          <Sample label='display · hero only'>
            <span className='text-display font-semibold tracking-tight'>
              Your battery is degrading.
            </span>
          </Sample>
          <Sample label='h1 · section headlines'>
            <span className='text-h1 font-semibold tracking-tight'>
              Quantify it. Defend the warranty.
            </span>
          </Sample>
          <Sample label='h2 · sub-section headlines'>
            <span className='text-h2 font-semibold tracking-tight'>
              Three blind spots that destroy battery value
            </span>
          </Sample>
          <Sample label='body · default paragraph'>
            <span className='text-body text-ink-2'>
              Fixed-scope performance audits and ongoing analytics for BESS
              operators, in two to three weeks.
            </span>
          </Sample>
          <Sample label='meta · captions, labels, kickers (mono)'>
            <span className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3'>
              Plant · NIMBUS-01 · 100MW/200MWh · UK
            </span>
          </Sample>
        </div>
      </MarketingSection>

      <HairlineRule />

      <MarketingSection size='default'>
        <h2 className='text-h2 font-semibold mb-8'>Color tokens</h2>
        <div className='grid grid-cols-2 md:grid-cols-4 gap-4'>
          <Swatch token='paper' bg='bg-paper' fg='text-ink' note='primary marketing bg' />
          <Swatch token='paper-2' bg='bg-paper-2' fg='text-ink' note='subtle bands' />
          <Swatch token='ink' bg='bg-ink' fg='text-paper' note='primary text' />
          <Swatch token='ink-2' bg='bg-ink-2' fg='text-paper' note='secondary text' />
          <Swatch token='ink-3' bg='bg-ink-3' fg='text-paper' note='meta / captions' />
          <Swatch token='divider' bg='bg-divider' fg='text-ink' note='hairline rules' />
          <Swatch token='data-bg' bg='bg-data-bg' fg='text-data-fg' note='instrument panel' />
          <Swatch token='data-bg-2' bg='bg-data-bg-2' fg='text-data-fg' note='panel header rail' />
          <Swatch token='signal-positive' bg='bg-signal-positive' fg='text-paper' note='on-track' />
          <Swatch token='signal-warning' bg='bg-signal-warning' fg='text-paper' note='live / flag' />
          <Swatch token='signal-critical' bg='bg-signal-critical' fg='text-paper' note='fault' />
          <Swatch token='primary' bg='bg-primary' fg='text-primary-foreground' note='CTA' />
        </div>
      </MarketingSection>

      <HairlineRule />

      <MarketingSection size='default'>
        <h2 className='text-h2 font-semibold mb-8'>Buttons</h2>
        <div className='flex flex-wrap items-center gap-3'>
          <Button>Book a BESS audit</Button>
          <Button variant='outline'>See the live demo</Button>
          <Button variant='secondary'>Secondary</Button>
          <Button variant='ghost'>Ghost</Button>
          <Button variant='link'>Link</Button>
          <Button size='lg'>Large</Button>
          <Button size='sm'>Small</Button>
          <Button disabled>Disabled</Button>
        </div>
      </MarketingSection>

      <HairlineRule />

      <MarketingSection size='default'>
        <h2 className='text-h2 font-semibold mb-8'>KPIReadout</h2>
        <div className='grid grid-cols-2 md:grid-cols-4 gap-8'>
          <KPIReadout value='91.4' label='SoH %' size='lg' />
          <KPIReadout value='€12.40' label='per cycle' delta='▲ 4.2%' signal='warning' size='lg' />
          <KPIReadout value='86.1' label='RTE %' signal='positive' size='lg' />
          <KPIReadout value='412' label='equiv. cycles' size='lg' />
        </div>
        <HairlineRule className='my-8' />
        <div className='grid grid-cols-2 md:grid-cols-4 gap-6'>
          <KPIReadout value='3-8%' label='annual revenue lost to soiling' />
          <KPIReadout value='12 d' label='avg detection lead time' signal='positive' />
          <KPIReadout value='€427/d' label='uplift after cleaning' />
          <KPIReadout value='94-97%' label='detection accuracy' />
        </div>
      </MarketingSection>

      <HairlineRule />

      <MarketingSection size='default'>
        <h2 className='text-h2 font-semibold mb-8'>Sparkline</h2>
        <div className='grid grid-cols-2 md:grid-cols-4 gap-8 items-center'>
          <SparkSample label='neutral' signal='neutral' />
          <SparkSample label='positive' signal='positive' />
          <SparkSample label='warning' signal='warning' />
          <SparkSample label='critical' signal='critical' />
        </div>
      </MarketingSection>

      <HairlineRule />

      <MarketingSection size='default'>
        <h2 className='text-h2 font-semibold mb-8'>DataPanel</h2>
        <div className='grid gap-6 md:grid-cols-2'>
          <DataPanel
            headerLeft='Plant · NIMBUS-01 · 100MW/200MWh · UK'
            headerRight='LFP'
            live
            footer='Updated 2 minutes ago · Showcase fixture'
            innerClassName='p-5'
          >
            <div className='grid grid-cols-3 gap-6'>
              <KPIReadout value='91.4' label='SoH %' tone='data' />
              <KPIReadout value='86.1' label='RTE %' tone='data' signal='positive' />
              <KPIReadout value='412' label='equiv. cycles' tone='data' />
            </div>
            <div className='mt-5'>
              <Sparkline values={sampleSeries} signal='warning' width={360} height={48} />
            </div>
          </DataPanel>

          <DataPanel
            headerLeft='Plant · HELIOS-01 · 30MW · Spain'
            headerRight='PV'
            live
            footer='Soiling forecast · 30-day horizon'
            innerClassName='p-5'
          >
            <div className='grid grid-cols-3 gap-6'>
              <KPIReadout value='96.0' label='soiling ratio %' tone='data' signal='positive' />
              <KPIReadout value='€427/d' label='loss if not cleaned' tone='data' signal='warning' />
              <KPIReadout value='14 d' label='days to clean' tone='data' />
            </div>
            <div className='mt-5'>
              <Sparkline values={sampleSeries.slice().reverse()} signal='positive' width={360} height={48} />
            </div>
          </DataPanel>
        </div>
      </MarketingSection>

      <HairlineRule />

      <MarketingSection size='default'>
        <h2 className='text-h2 font-semibold mb-8'>Section surfaces</h2>
        <div className='space-y-0 border border-divider rounded-sm overflow-hidden'>
          <div className='bg-paper p-6 text-meta font-mono uppercase tracking-[0.08em] text-ink-3'>
            paper · default
          </div>
          <HairlineRule />
          <div className='bg-paper-2 p-6 text-meta font-mono uppercase tracking-[0.08em] text-ink-3'>
            paper-2 · subtle band
          </div>
          <HairlineRule />
          <div className='bg-data-bg p-6 text-meta font-mono uppercase tracking-[0.08em] text-data-fg-2'>
            data-bg · instrument panel
          </div>
        </div>
      </MarketingSection>
    </main>
  );
}

function Sample({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='grid grid-cols-1 md:grid-cols-[180px_1fr] gap-3 md:gap-8 items-baseline'>
      <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3'>{label}</div>
      <div>{children}</div>
    </div>
  );
}

function Swatch({
  token,
  bg,
  fg,
  note,
}: {
  token: string;
  bg: string;
  fg: string;
  note: string;
}) {
  return (
    <div className='border border-divider rounded-sm overflow-hidden'>
      <div className={`${bg} ${fg} px-3 py-6 font-mono text-meta`}>{token}</div>
      <div className='px-3 py-2 text-meta text-ink-3 bg-paper border-t border-divider'>{note}</div>
    </div>
  );
}

function SparkSample({
  label,
  signal,
}: {
  label: string;
  signal: 'positive' | 'warning' | 'critical' | 'neutral';
}) {
  return (
    <div>
      <Sparkline values={sampleSeries} signal={signal} width={200} height={36} />
      <div className='mt-2 font-mono text-meta uppercase tracking-[0.08em] text-ink-3'>{label}</div>
    </div>
  );
}
