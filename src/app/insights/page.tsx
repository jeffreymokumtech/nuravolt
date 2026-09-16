import { getSEOTags, buildBreadcrumbSchema } from '@/libs/seo';
import PublicLayout from '@/components/layouts/PublicLayout';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import Breadcrumbs from '@/components/content/Breadcrumbs';
import ContentCatalogGrid, { CatalogCard } from '@/components/content/ContentCatalogGrid';
import { insights } from '@/data/content/insights';

export const metadata = getSEOTags({
  title: 'Insights, solar & storage analytics | NuraVolt',
  description:
    'Technical perspectives on PV and BESS ops: warranty disputes and SCADA data, the economics of cleaning, and the PPA metrics that trigger penalties.',
  canonicalUrlRelative: '/insights',
  keywords: ['BESS warranty', 'solar soiling economics', 'PPA performance guarantee', 'solar analytics', 'battery degradation'],
});

export default function InsightsIndexPage() {
  const crumbs = [
    { name: 'Home', href: '/' },
    { name: 'Insights', href: '/insights' },
  ];

  const cards: CatalogCard[] = insights.map((i) => ({
    title: i.title,
    href: `/insights/${i.slug}`,
    description: i.intro,
  }));

  return (
    <PublicLayout>
      <SchemaJsonLd
        data={buildBreadcrumbSchema(crumbs.map((c) => ({ name: c.name, urlRelative: c.href })))}
      />
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-10 max-w-5xl">
        <Breadcrumbs items={crumbs} />
        <h1 className="text-3xl sm:text-4xl font-bold text-ink tracking-tight">Insights</h1>
        <p className="mt-3 max-w-2xl text-lg text-ink-2">
          Where the money actually moves in solar and storage operations, warranty evidence,
          cleaning economics, and PPA performance guarantees.
        </p>
        <div className="mt-8">
          <ContentCatalogGrid cards={cards} />
        </div>
      </div>
    </PublicLayout>
  );
}
