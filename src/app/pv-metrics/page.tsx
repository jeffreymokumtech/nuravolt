import { getSEOTags, buildBreadcrumbSchema } from '@/libs/seo';
import PublicLayout from '@/components/layouts/PublicLayout';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import Breadcrumbs from '@/components/content/Breadcrumbs';
import ContentCatalogGrid, { CatalogCard } from '@/components/content/ContentCatalogGrid';
import { pvMetrics } from '@/data/content/pvMetrics';

export const metadata = getSEOTags({
  title: 'PV performance metrics explained | NuraVolt',
  description:
    'The solar metrics that decide yield and contracts, Performance Ratio, CUF, specific yield, availability, and expected-vs-actual, defined plainly with formulas.',
  canonicalUrlRelative: '/pv-metrics',
  keywords: ['performance ratio', 'capacity utilisation factor', 'specific yield', 'plant availability', 'PV performance metrics', 'solar plant KPIs'],
});

export default function PvMetricsIndexPage() {
  const crumbs = [
    { name: 'Home', href: '/' },
    { name: 'PV metrics', href: '/pv-metrics' },
  ];

  const cards: CatalogCard[] = pvMetrics.map((m) => ({
    title: m.title,
    href: `/pv-metrics/${m.slug}`,
    description: m.intro,
  }));

  return (
    <PublicLayout>
      <SchemaJsonLd
        data={buildBreadcrumbSchema(crumbs.map((c) => ({ name: c.name, urlRelative: c.href })))}
      />
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-10 max-w-5xl">
        <Breadcrumbs items={crumbs} />
        <h1 className="text-3xl sm:text-4xl font-bold text-ink tracking-tight">
          PV performance metrics &amp; concepts
        </h1>
        <p className="mt-3 max-w-2xl text-lg text-ink-2">
          The solar-plant metrics that actually decide yield, contracts, and warranty standing, defined plainly, with the formulas, typical ranges, and how NuraVolt tracks each one.
        </p>
        <div className="mt-8">
          <ContentCatalogGrid cards={cards} />
        </div>
      </div>
    </PublicLayout>
  );
}
