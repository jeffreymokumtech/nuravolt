import Link from 'next/link';
import PublicLayout from '@/components/layouts/PublicLayout';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import Breadcrumbs from '@/components/content/Breadcrumbs';
import ContentCta from '@/components/content/ContentCta';
import QuickAnswer from '@/components/content/QuickAnswer';
import { getSEOTags, buildArticleSchema, buildBreadcrumbSchema } from '@/libs/seo';

const SLUG = '/blog/augment-vs-overbuild';
const TITLE = 'Augment or overbuild? How analytics defers the spend';
const META_TITLE = 'Augment vs overbuild: defer the spend | NuraVolt';
const DESCRIPTION =
  'Augmentation timing is one of the biggest line items in a storage business case, and it is set by your real degradation rate, not the warranty’s conservative curve.';
const PUBLISHED = '2026-06-15';

export const metadata = getSEOTags({
  title: META_TITLE,
  description: DESCRIPTION,
  canonicalUrlRelative: SLUG,
  keywords: ['battery augmentation', 'overbuild vs augment', 'BESS degradation', 'LCOS', 'storage business case'],
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
        <p className="font-mono text-meta uppercase tracking-[0.08em] text-primary mb-2">BESS · Economics</p>
        <h1 className="text-3xl sm:text-4xl font-bold text-ink tracking-tight">{TITLE}</h1>
        <p className="mt-3 font-mono text-meta uppercase tracking-[0.08em] text-ink-3">15 June 2026 · 5 min read</p>

        <QuickAnswer>{DESCRIPTION}</QuickAnswer>

        <div className="mt-8 space-y-5 text-ink-2 leading-relaxed">
          <p className="text-lg text-ink">
            Every grid-scale battery faces the same arithmetic. It fades a little every year, but the
            offtake contract wants a fixed amount of energy delivered for fifteen or twenty. So you
            either start oversized, overbuild, or add capacity later, augment. The choice is one
            of the largest numbers in the whole business case, and most teams pick it from a
            spreadsheet assumption rather than from data.
          </p>

          <h2 className="text-xl font-semibold text-ink pt-4">The real trade-off</h2>
          <p>
            Overbuilding spends capital up front and wastes some of it if the pack ages slowly.
            <Link href="/bess/augmentation" className="text-primary underline underline-offset-2"> Augmentation</Link>{' '}
            defers the spend, typically to around Year 5 to 7, but adds complexity: it has to be
            sized to the cumulative capacity lost, it interacts with the warranty, and in some
            markets the investment-tax-credit treatment of capacity added later is materially worse
            than capacity installed on day one. There is no universal winner. The answer depends on
            one variable above all: how fast the battery actually degrades.
          </p>

          <h2 className="text-xl font-semibold text-ink pt-4">The curve you plan against is deliberately pessimistic</h2>
          <p>
            Warranty degradation curves are conservative by design, the OEM is protecting itself.
            If you size augmentation reserves against that curve, you are budgeting for a worse
            battery than you probably have. The gap between the contracted curve and the pack&rsquo;s
            real{' '}
            <Link href="/bess/state-of-health" className="text-primary underline underline-offset-2">state of health</Link>{' '}
            is exactly the room you have to defer and shrink the spend.
          </p>

          <p>
            This is what analytics changes. When you trend measured SoH against the contracted curve,
            you can project the actual date the asset crosses its{' '}
            <Link href="/bess/capacity-maintenance" className="text-primary underline underline-offset-2">contracted-capacity floor</Link>{' '}, and that date is usually later, sometimes by years, than the warranty assumption. A
            battery beating its curve might need its first augmentation in Year 8 instead of Year 5,
            and a smaller one when it comes. That is capital deferred and capital saved, straight off
            a measurement you already have the data to make.
          </p>

          <h2 className="text-xl font-semibold text-ink pt-4">Make it a schedule, not an assumption</h2>
          <p>
            The practical move is to stop treating augmentation as a fixed line in the LCOS model and
            start treating it as a data-driven schedule that updates as the asset ages. Watch the real
            fade rate; let it tell you when, and how much, to augment. Overbuild or augment stops
            being a one-time bet made at financial close and becomes a decision you can keep
            sharpening with every quarter of operating data.
          </p>
        </div>

        <ContentCta />
      </article>
    </PublicLayout>
  );
}
