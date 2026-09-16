import Link from 'next/link';
import PublicLayout from '@/components/layouts/PublicLayout';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import Breadcrumbs from '@/components/content/Breadcrumbs';
import ContentCta from '@/components/content/ContentCta';
import QuickAnswer from '@/components/content/QuickAnswer';
import { getSEOTags, buildArticleSchema, buildBreadcrumbSchema } from '@/libs/seo';

const SLUG = '/blog/leading-with-bess-2026';
const TITLE = 'Why we’re leading with BESS in 2026, and the warranty mistake we keep seeing';
const META_TITLE = 'Why we lead with BESS in 2026 | NuraVolt';
const DESCRIPTION =
  'Battery storage is where the money and risk now sit, and the recurring mistake is treating the warranty as a filed document, not a live data position.';
const PUBLISHED = '2026-06-10';

export const metadata = getSEOTags({
  title: META_TITLE,
  description: DESCRIPTION,
  canonicalUrlRelative: SLUG,
  keywords: ['BESS warranty', 'battery storage strategy', 'degradation', 'asset management', 'energy storage 2026'],
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
        <p className="font-mono text-meta uppercase tracking-[0.08em] text-primary mb-2">BESS · Perspective</p>
        <h1 className="text-3xl sm:text-4xl font-bold text-ink tracking-tight">{TITLE}</h1>
        <p className="mt-3 font-mono text-meta uppercase tracking-[0.08em] text-ink-3">10 June 2026 · 5 min read</p>

        <QuickAnswer>{DESCRIPTION}</QuickAnswer>

        <div className="mt-8 space-y-5 text-ink-2 leading-relaxed">
          <p className="text-lg text-ink">
            We started in solar, and PV monitoring is still core to what we do. But over the last
            year we have deliberately led with battery storage, and it is worth saying why,
            because it explains the one mistake we see almost every BESS operator make.
          </p>

          <h2 className="text-xl font-semibold text-ink pt-4">Where the money and the risk moved</h2>
          <p>
            A modern utility BESS is an eight-figure asset whose value erodes every day it
            operates. Unlike a solar array, where degradation is slow and fairly benign, a battery
            is degraded by exactly the thing that earns it revenue, cycling. Every dispatch
            decision trades money today against capacity tomorrow. That tension makes storage the
            most analytically interesting asset on a renewables balance sheet, and the one where
            good data changes the financial outcome most.
          </p>
          <p>
            The metrics that decide that outcome are not exotic. They are{' '}
            <Link href="/bess/state-of-health" className="text-primary underline underline-offset-2">state of health</Link>,{' '}
            <Link href="/bess/equivalent-full-cycles" className="text-primary underline underline-offset-2">equivalent full cycles</Link>,{' '}
            <Link href="/bess/depth-of-discharge" className="text-primary underline underline-offset-2">depth of discharge</Link>, and the
            temperature and SoC windows the asset lives in. Track them and dispatch becomes a
            deliberate trade-off. Ignore them and you are guessing with someone else&rsquo;s capital.
          </p>

          <h2 className="text-xl font-semibold text-ink pt-4">The mistake: the warranty as a filing cabinet</h2>
          <p>
            Here is the pattern we keep seeing. The warranty, the thing that protects the largest
            single risk on the asset, is treated as a document. It gets signed, filed, and
            forgotten until something goes wrong. By then, the data needed to make a claim was
            either never captured or never organised, and the operator is negotiating from weakness.
          </p>
          <p>
            The warranty is not a document. It is a continuous data position. It hinges on two
            limits, capacity retention and energy throughput, plus a set of operating-window
            conditions whose violation voids cover. Whether you have a claim, or a liability, is
            knowable at any moment from your own SCADA and BMS data. We make that argument in full
            in{' '}
            <Link href="/insights/warranty-disputes-scada-data" className="text-primary underline underline-offset-2">
              why warranty disputes are won or lost in SCADA data
            </Link>, and we treat the warranty itself as something you measure, not store, the idea
            behind{' '}
            <Link href="/bess/warranty-as-data-product" className="text-primary underline underline-offset-2">
              warranty as a data product
            </Link>.
          </p>

          <h2 className="text-xl font-semibold text-ink pt-4">What this means for an operator</h2>
          <p>
            You do not need to rip anything out. The data already exists; it is in your inverters,
            your BMS, your SCADA historian. The work is turning it into a live, honest view of where
            each asset stands against its warranty curve and its operating windows, so dispatch is
            deliberate and a claim, if it comes, is already evidenced.
          </p>
          <p>
            That is why we lead with BESS. It is where the analytics earn their keep most directly,
            and where the gap between &ldquo;we have a warranty&rdquo; and &ldquo;we can prove our
            position&rdquo; is widest. The full reference lives in the{' '}
            <Link href="/bess" className="text-primary underline underline-offset-2">BESS metrics library</Link>; the
            product that operationalises it is our{' '}
            <Link href="/solutions/bess-monitoring" className="text-primary underline underline-offset-2">BESS analytics</Link>.
          </p>
        </div>

        <ContentCta />
      </article>
    </PublicLayout>
  );
}
