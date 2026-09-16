import { getSEOTags, buildBreadcrumbSchema } from '@/libs/seo';
import PublicLayout from '@/components/layouts/PublicLayout';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import Breadcrumbs from '@/components/content/Breadcrumbs';
import ContentCatalogGrid, { CatalogCard } from '@/components/content/ContentCatalogGrid';
import { bessMetrics } from '@/data/content/bessMetrics';

export const metadata = getSEOTags({
  title: 'BESS metrics & concepts explained | NuraVolt',
  description:
    'The battery-storage metrics that decide warranty and revenue, SoH, round-trip efficiency, depth of discharge, equivalent full cycles, and more.',
  canonicalUrlRelative: '/bess',
  keywords: ['BESS metrics', 'state of health', 'round-trip efficiency', 'depth of discharge', 'equivalent full cycles', 'battery degradation'],
});

export default function BessIndexPage() {
  const crumbs = [
    { name: 'Home', href: '/' },
    { name: 'BESS metrics', href: '/bess' },
  ];

  const cards: CatalogCard[] = bessMetrics.map((m) => ({
    title: m.title,
    href: `/bess/${m.slug}`,
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
          BESS metrics &amp; concepts
        </h1>
        <p className="mt-3 max-w-2xl text-lg text-ink-2">
          The battery-storage metrics that actually decide warranty standing and revenue, defined plainly, with the formulas, typical ranges, and how NuraVolt tracks each one.
        </p>
        <div className="mt-8">
          <ContentCatalogGrid cards={cards} />
        </div>
      </div>
    </PublicLayout>
  );
}
