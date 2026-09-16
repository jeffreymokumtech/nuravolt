import Link from 'next/link';
import PublicLayout from '@/components/layouts/PublicLayout';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import Breadcrumbs from '@/components/content/Breadcrumbs';
import ContentCta from '@/components/content/ContentCta';
import QuickAnswer from '@/components/content/QuickAnswer';
import { getSEOTags, buildArticleSchema, buildBreadcrumbSchema } from '@/libs/seo';

const SLUG = '/blog/iberian-blackout-bess-readiness';
const TITLE = 'What the Iberian blackout exposed about BESS readiness';
const META_TITLE = 'Iberian blackout & BESS readiness | NuraVolt';
const DESCRIPTION =
  'The April 2025 Iberian blackout was a stress test for storage, the assets that fared best belonged to operators who already knew their batteries’ real state.';
const PUBLISHED = '2026-06-10';

export const metadata = getSEOTags({
  title: META_TITLE,
  description: DESCRIPTION,
  canonicalUrlRelative: SLUG,
  keywords: ['Iberian blackout', 'BESS readiness', 'grid stability', 'battery storage Spain', 'frequency response'],
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
        <p className="font-mono text-meta uppercase tracking-[0.08em] text-primary mb-2">BESS · Market</p>
        <h1 className="text-3xl sm:text-4xl font-bold text-ink tracking-tight">{TITLE}</h1>
        <p className="mt-3 font-mono text-meta uppercase tracking-[0.08em] text-ink-3">10 June 2026 · 6 min read</p>

        <QuickAnswer>{DESCRIPTION}</QuickAnswer>

        <div className="mt-8 space-y-5 text-ink-2 leading-relaxed">
          <p className="text-lg text-ink">
            On 28 April 2025 the Iberian Peninsula went dark. Spain and Portugal lost grid supply
            almost simultaneously in one of Europe&rsquo;s largest blackouts in decades. The
            forensic post-mortems are still being argued over, but for storage operators the
            lesson is already clear, and it is not the one most people expected.
          </p>

          <p>
            The headline debate was about inertia and renewables: can a grid leaning hard on solar
            and wind ride through a fast disturbance? Battery storage is part of that answer, and
            the event has accelerated procurement across Iberia. But the more useful question for
            anyone <em>already</em> operating a BESS is narrower: when the grid asked your asset to
            perform, did you actually know what it could deliver?
          </p>

          <h2 className="text-xl font-semibold text-ink pt-4">Readiness is a data question, not a hardware question</h2>
          <p>
            A battery&rsquo;s nameplate is a beginning-of-life number. What it can deliver during a
            real event depends on its present{' '}
            <Link href="/bess/state-of-health" className="text-primary underline underline-offset-2">state of health</Link>,
            its{' '}
            <Link href="/bess/round-trip-efficiency" className="text-primary underline underline-offset-2">round-trip efficiency</Link>,
            its thermal headroom, and how close it is sitting to the edges of its operating window.
            Operators who track those continuously knew, going in, exactly how much usable energy
            and power they had. Operators relying on the BMS dashboard found out in real time, which is the wrong moment to learn that a string was quietly down on capacity.
          </p>

          <p>
            The assets that looked best afterwards were not the newest ones. They were the ones
            whose operators had a live, honest picture of degradation and thermal state, so the
            response was predictable. That is the unglamorous truth the blackout surfaced:
            readiness is mostly bookkeeping you either did or didn&rsquo;t do beforehand.
          </p>

          <h2 className="text-xl font-semibold text-ink pt-4">Three things worth checking on your own fleet</h2>
          <p>
            If the event prompted an internal review, and across our conversations in the Iberian
            market, it has, these are the questions that separate a confident answer from a shrug:
          </p>
          <ul className="list-disc space-y-1.5 pl-5 marker:text-primary">
            <li>
              Do you know each string&rsquo;s real usable capacity today, not its rated capacity? If
              the gap is a surprise, that is a{' '}
              <Link href="/faults/bess-capacity-fade" className="text-primary underline underline-offset-2">capacity-fade</Link>{' '}
              tracking gap.
            </li>
            <li>
              How much thermal headroom did the asset have during the event? Heat is the silent
              constraint, see{' '}
              <Link href="/faults/bess-thermal-stress" className="text-primary underline underline-offset-2">thermal stress</Link>.
            </li>
            <li>
              Could you reconstruct, from data, exactly how the asset behaved minute-by-minute? If
              a warranty or performance question follows, that record is the whole argument.
            </li>
          </ul>

          <p>
            None of this requires new hardware. It requires reading the SCADA and BMS data you
            already generate and turning it into a current, trustworthy view of the asset. That is
            the entire premise of our{' '}
            <Link href="/solutions/bess-monitoring" className="text-primary underline underline-offset-2">BESS analytics</Link>, and
            the deeper reference sits in the{' '}
            <Link href="/bess" className="text-primary underline underline-offset-2">BESS metrics library</Link>.
          </p>

          <p>
            The next disturbance will not announce itself. The work that makes you ready for it is
            the work you do on a quiet Tuesday, knowing, to a number, what your batteries can do.
          </p>
        </div>

        <ContentCta />
      </article>
    </PublicLayout>
  );
}
