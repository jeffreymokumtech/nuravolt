import Link from 'next/link';
import PublicLayout from '@/components/layouts/PublicLayout';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import Breadcrumbs from '@/components/content/Breadcrumbs';
import ContentCta from '@/components/content/ContentCta';
import QuickAnswer from '@/components/content/QuickAnswer';
import { getSEOTags, buildArticleSchema, buildBreadcrumbSchema } from '@/libs/seo';

const SLUG = '/blog/soiling-season-field-note';
const TITLE = 'Soiling season is here: a field note on when cleaning actually pays';
const META_TITLE = 'When is solar panel cleaning worth it? | NuraVolt';
const DESCRIPTION =
  'Soiling climbs once the spring rain stops. A field note on skipping the fixed-calendar clean and letting the numbers decide when cleaning actually pays.';
const PUBLISHED = '2026-06-10';

export const metadata = getSEOTags({
  title: META_TITLE,
  description: DESCRIPTION,
  canonicalUrlRelative: SLUG,
  keywords: ['solar soiling', 'panel cleaning', 'soiling season', 'cleaning ROI', 'PV O&M'],
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
        <p className="font-mono text-meta uppercase tracking-[0.08em] text-primary mb-2">PV · Field note</p>
        <h1 className="text-3xl sm:text-4xl font-bold text-ink tracking-tight">{TITLE}</h1>
        <p className="mt-3 font-mono text-meta uppercase tracking-[0.08em] text-ink-3">10 June 2026 · 3 min read</p>

        <QuickAnswer>{DESCRIPTION}</QuickAnswer>

        <div className="mt-8 space-y-5 text-ink-2 leading-relaxed">
          <p className="text-lg text-ink">
            It is June. Across Iberia and the Gulf the spring rain has stopped, and on the plants we
            watch the soiling ratio has started its slow seasonal decline. This is the time of year
            the cleaning question gets asked, and answered badly.
          </p>

          <p>
            The bad answer is the calendar: &ldquo;we clean in June and September.&rdquo; It feels
            disciplined. It is mostly luck. A fixed date over-cleans when a rain front was two days
            out, and under-cleans through a long dry, dusty spell that is quietly costing more than
            the clean would. The calendar optimises for the crew&rsquo;s convenience, not the
            asset&rsquo;s yield.
          </p>

          <h2 className="text-xl font-semibold text-ink pt-4">The only question that matters</h2>
          <p>
            Cleaning pays when the value of the energy you would recover <em>before the next
            cleaning rain</em> exceeds the cost of the clean. That is it. The inputs are the
            site&rsquo;s soiling rate, the tariff or PPA price on the recoverable kWh, and the rain
            forecast, and all three are site-specific and time-varying, which is precisely why a
            fixed date can&rsquo;t be right two years running.
          </p>

          <p>
            We wrote the full treatment of that calculation, including how the soiling ratio is
            estimated when there&rsquo;s no dust sensor on site, here:{' '}
            <Link href="/insights/soiling-cleaning-economics" className="text-primary underline underline-offset-2">
              Soiling loss: when is cleaning worth it?
            </Link>{' '}
            The mechanics of the loss itself sit on the{' '}
            <Link href="/faults/soiling-loss" className="text-primary underline underline-offset-2">soiling-loss</Link>{' '}
            reference page.
          </p>

          <h2 className="text-xl font-semibold text-ink pt-4">What to do this week</h2>
          <p>
            If you have a clean scheduled on the calendar for this month, do one thing before you
            dispatch the crew: check the soiling trajectory against the ten-day rain forecast. If
            rain is likely to do the job for free, defer. If you are in a dry run with a high
            soiling rate and a good tariff, you may already be past break-even, clean sooner, not
            on the date. Let the numbers, not the month, make the call.
          </p>
        </div>

        <ContentCta />
      </article>
    </PublicLayout>
  );
}
