import { getSEOTags, buildBreadcrumbSchema } from '@/libs/seo';
import PublicLayout from '@/components/layouts/PublicLayout';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import Breadcrumbs from '@/components/content/Breadcrumbs';
import ContentCatalogGrid, { CatalogCard } from '@/components/content/ContentCatalogGrid';
import { regions } from '@/data/content/regions';

export const metadata = getSEOTags({
  title: 'Solar monitoring software by country | NuraVolt',
  description:
    'Independent solar monitoring and analytics, by market: grid code obligations, soiling climate, inverter landscape, and deployment notes for the countries we serve.',
  canonicalUrlRelative: '/solar-monitoring',
  keywords: [
    'solar monitoring software',
    'PV plant monitoring',
    'solar analytics',
    'solar monitoring South Africa',
    'solar monitoring Spain',
    'solar monitoring Kenya',
  ],
});

export default function SolarMonitoringIndexPage() {
  const crumbs = [
    { name: 'Home', href: '/' },
    { name: 'Solar monitoring', href: '/solar-monitoring' },
  ];

  const cards: CatalogCard[] = regions.map((r) => ({
    title: r.title,
    href: `/solar-monitoring/${r.slug}`,
    description: r.intro,
  }));

  return (
    <PublicLayout>
      <SchemaJsonLd
        data={buildBreadcrumbSchema(crumbs.map((c) => ({ name: c.name, urlRelative: c.href })))}
      />
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-10 max-w-5xl">
        <Breadcrumbs items={crumbs} />
        <h1 className="text-3xl sm:text-4xl font-bold text-ink tracking-tight">
          Solar monitoring, by country
        </h1>
        <p className="mt-3 max-w-2xl text-lg text-ink-2">
          The same platform, different obligations. Each guide covers what actually changes by
          market: grid code and reporting rules, soiling climate, the inverter landscape, and
          how a software-only deployment works there.
        </p>
        <div className="mt-8">
          <ContentCatalogGrid cards={cards} />
        </div>
      </div>
    </PublicLayout>
  );
}
