import Link from 'next/link';
import PublicLayout from '@/components/layouts/PublicLayout';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import Breadcrumbs from '@/components/content/Breadcrumbs';
import ContentCta from '@/components/content/ContentCta';
import QuickAnswer from '@/components/content/QuickAnswer';
import { getSEOTags, buildArticleSchema, buildBreadcrumbSchema } from '@/libs/seo';

const SLUG = '/blog/bms-monitoring-not-enough-2026';
const TITLE = 'Why cell-level BMS monitoring is no longer enough in 2026';
const META_TITLE = 'Why cell-level BMS monitoring isn’t enough | NuraVolt';
const DESCRIPTION =
  'The failures putting BESS assets at risk increasingly live in the balance-of-system, cooling, HVAC, connections, which the BMS was never designed to see.';
const PUBLISHED = '2026-06-15';

export const metadata = getSEOTags({
  title: META_TITLE,
  description: DESCRIPTION,
  canonicalUrlRelative: SLUG,
  keywords: ['BESS monitoring', 'battery BMS', 'balance of system', 'thermal management', 'battery storage safety 2026'],
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
        <p className="font-mono text-meta uppercase tracking-[0.08em] text-primary mb-2">BESS · Monitoring</p>
        <h1 className="text-3xl sm:text-4xl font-bold text-ink tracking-tight">{TITLE}</h1>
        <p className="mt-3 font-mono text-meta uppercase tracking-[0.08em] text-ink-3">15 June 2026 · 5 min read</p>

        <QuickAnswer>{DESCRIPTION}</QuickAnswer>

        <div className="mt-8 space-y-5 text-ink-2 leading-relaxed">
          <p className="text-lg text-ink">
            For a decade the battery management system has been the centre of BESS monitoring, and
            for good reason: it watches every cell&rsquo;s voltage, current, and temperature, and it
            keeps the pack inside its safe operating window. But the failures that dominate the 2026
            incident record increasingly sit <em>outside</em> the cells, and therefore outside what
            the BMS was ever designed to see.
          </p>

          <h2 className="text-xl font-semibold text-ink pt-4">The blind spot is the balance-of-system</h2>
          <p>
            Industry inspections keep finding the same thing: a meaningful share of deployed BESS
            units have defects in fire-suppression or thermal-management systems, the cooling,
            HVAC, connections, and enclosure hardware collectively called the balance-of-system.
            None of that is cell-level data. A monitoring architecture that watches cells and
            assumes the balance-of-system is fine is, by construction, built to catch the minority
            of failures and miss the majority.
          </p>

          <p>
            The most expensive version is thermal. A chiller losing efficiency, a fouled filter, or
            a failing fan doesn&rsquo;t move any cell voltage, so the BMS reports healthy cells
            right up until the heat has already done its work. And heat is not a minor factor:
            sustained operation around 10&deg;C above optimal roughly doubles the ageing rate of
            lithium-ion cells. A cooling system that degrades unnoticed quietly consumes years of
            warranty life. We treat that as its own fault mode,{' '}
            <Link href="/faults/balance-of-system-thermal" className="text-primary underline underline-offset-2">
              balance-of-system thermal failure
            </Link>{' '}, precisely because the BMS can&rsquo;t raise it.
          </p>

          <h2 className="text-xl font-semibold text-ink pt-4">Why &ldquo;the cells look fine&rdquo; is the trap</h2>
          <p>
            The danger is that cell-level health and system-level health get conflated. You can have
            a perfectly healthy set of cells inside an enclosure that is slowly cooking them. By the
            time the damage shows up in the cell data, as{' '}
            <Link href="/faults/bess-thermal-stress" className="text-primary underline underline-offset-2">thermal stress</Link>{' '}
            and then accelerated capacity fade, it is no longer preventable; it is recorded. The
            cheap repair (a filter, a fan, a coolant top-up) was available for weeks, but nothing in
            the cell stream pointed at it.
          </p>

          <h2 className="text-xl font-semibold text-ink pt-4">What &ldquo;enough&rdquo; looks like now</h2>
          <p>
            The fix is not more cell sensors. It is a model. If you know the dispatch, the ambient
            temperature, and the C-rate, you can compute the pack temperature the system{' '}
            <em>should</em> be running at, and flag the residual when it runs hot. That residual is
            the cooling system degrading, made visible before it ages the pack. The same approach
            extends across the balance-of-system: expected versus actual, with the gap attributed to
            a cause and a cost.
          </p>

          <p>
            None of this replaces the BMS, it surrounds it. The BMS keeps the cells safe; a
            system-level model keeps the asset honest. The deeper reference on the metrics this
            protects sits in the{' '}
            <Link href="/bess" className="text-primary underline underline-offset-2">BESS metrics library</Link>.
            In 2026, watching the cells and trusting the rest is no longer enough.
          </p>
        </div>

        <ContentCta />
      </article>
    </PublicLayout>
  );
}
