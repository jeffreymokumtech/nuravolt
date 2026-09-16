import Link from 'next/link';
import PublicLayout from '@/components/layouts/PublicLayout';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import Breadcrumbs from '@/components/content/Breadcrumbs';
import ContentCta from '@/components/content/ContentCta';
import QuickAnswer from '@/components/content/QuickAnswer';
import { getSEOTags, buildArticleSchema, buildBreadcrumbSchema } from '@/libs/seo';

const SLUG = '/blog/clipping-hides-soiling';
const TITLE = 'How inverter clipping hides your soiling losses';
const META_TITLE = 'How clipping hides your soiling losses | NuraVolt';
const DESCRIPTION =
  'When an inverter is clipping, moderate soiling and string losses can vanish from the AC data, the plant looks stable while yield quietly leaks under the cap.';
const PUBLISHED = '2026-06-15';

export const metadata = getSEOTags({
  title: META_TITLE,
  description: DESCRIPTION,
  canonicalUrlRelative: SLUG,
  keywords: ['inverter clipping', 'soiling losses', 'DC/AC ratio', 'performance ratio masking', 'PV monitoring'],
});

export default function Post() {
  const crumbs = [
    { name: 'Home', urlRelative: '/' },
    { name: 'Blog', urlRelative: '/blog' },
    { name: TITLE, urlRelative: SLUG },
  ];

  return (
    <PublicLayout>
      <SchemaJsonLd
        data={[
          buildArticleSchema({ title: TITLE, description: DESCRIPTION, urlRelative: SLUG, datePublished: PUBLISHED }),
          buildBreadcrumbSchema(crumbs),
        ]}
      />
      <article className="container mx-auto px-4 sm:px-6 lg:px-8 py-10 max-w-3xl">
        <Breadcrumbs items={crumbs.map((c) => ({ name: c.name, href: c.urlRelative }))} />
        <p className="font-mono text-meta uppercase tracking-[0.08em] text-primary mb-2">PV · Monitoring</p>
        <h1 className="text-3xl sm:text-4xl font-bold text-ink tracking-tight">{TITLE}</h1>
        <p className="mt-3 font-mono text-meta uppercase tracking-[0.08em] text-ink-3">15 June 2026 · 4 min read</p>

        <QuickAnswer>{DESCRIPTION}</QuickAnswer>

        <div className="mt-8 space-y-5 text-ink-2 leading-relaxed">
          <p className="text-lg text-ink">
            Here is a quietly expensive failure mode that almost never gets flagged: a plant that is
            losing money to soiling while every dashboard says it is fine. The culprit is the
            interaction between two things operators usually look at separately,{' '}
            <Link href="/faults/inverter-clipping" className="text-primary underline underline-offset-2">inverter clipping</Link>{' '}
            and{' '}
            <Link href="/faults/soiling-loss" className="text-primary underline underline-offset-2">soiling</Link>.
          </p>

          <h2 className="text-xl font-semibold text-ink pt-4">What clipping does to your data</h2>
          <p>
            Modern plants are built with a DC array larger than the inverter&rsquo;s AC rating, a
            high DC/AC ratio, so the inverter spends the sunniest hours pinned at its limit,
            discarding the surplus DC. That is designed-in. The problem is what it does to your
            visibility: while the inverter is saturating, the AC output is flat at the cap and
            <em> stops responding to changes on the DC side</em>.
          </p>

          <p>
            So picture moderate soiling building up over a dry spell. It is shaving a few percent off
            the DC the array can produce. But if the array was clipping, that lost DC was headroom
            that was being thrown away anyway, so the AC output, and therefore the measured
            Performance Ratio, barely moves. The soiling loss is real, but during the clipped hours
            it is invisible. The plant looks stable while yield leaks under the cap.
          </p>

          <h2 className="text-xl font-semibold text-ink pt-4">Why a flat PR can be a lie</h2>
          <p>
            This is the trap: a plant with significant clipping can show a reassuringly steady{' '}
            <Link href="/pv-metrics/performance-ratio" className="text-primary underline underline-offset-2">Performance Ratio</Link>{' '}
            while soiling, string-level degradation, or bypass-diode faults quietly accumulate
            underneath. The masking lifts only at the shoulders of the day and in lower-irradiance
            conditions, when the array drops out of clipping and the loss suddenly shows, by which
            point it has been costing you for weeks.
          </p>

          <h2 className="text-xl font-semibold text-ink pt-4">Seeing under the cap</h2>
          <p>
            The way through it is to stop judging the plant on clipped AC output alone. You have to
            model the DC the array <em>should</em> be producing for the irradiance it is receiving,
            and compare against that, an{' '}
            <Link href="/pv-metrics/energy-performance-index" className="text-primary underline underline-offset-2">expected-versus-actual</Link>{' '}
            view that works at the DC level and during the unclipped hours, where the loss is honest.
            Do that, and soiling stops hiding behind the cap: you can see it accumulate, price it,
            and decide whether the next clean is worth it before the shoulder-hour numbers force the
            question.
          </p>

          <p>
            Clipping is not a fault, it is a design choice. But if your monitoring reads clipped AC
            as &ldquo;healthy,&rdquo; it will keep telling you the plant is fine while it isn&rsquo;t.
          </p>
        </div>

        <ContentCta />
      </article>
    </PublicLayout>
  );
}
