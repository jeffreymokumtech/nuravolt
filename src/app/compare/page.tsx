import { getSEOTags, buildBreadcrumbSchema } from '@/libs/seo';
import PublicLayout from '@/components/layouts/PublicLayout';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import Breadcrumbs from '@/components/content/Breadcrumbs';
import ContentCatalogGrid, { CatalogCard } from '@/components/content/ContentCatalogGrid';
import { comparisons } from '@/data/content/comparisons';

export const metadata = getSEOTags({
  title: 'Compare solar monitoring platforms | NuraVolt',
  description:
    'Honest comparisons of solar monitoring approaches and platforms: soiling stations vs software, vendor portals vs independent analytics, named alternatives, and what monitoring software actually costs.',
  canonicalUrlRelative: '/compare',
  keywords: [
    'solar monitoring software comparison',
    'solar monitoring software pricing',
    'soiling monitoring',
    'solar analytics alternative',
    'PV monitoring platforms',
  ],
});

export default function CompareIndexPage() {
  const crumbs = [
    { name: 'Home', href: '/' },
    { name: 'Compare', href: '/compare' },
  ];

  const cards: CatalogCard[] = comparisons.map((c) => ({
    title: c.title,
    href: `/compare/${c.slug}`,
    description: c.intro,
  }));

  return (
    <PublicLayout>
      <SchemaJsonLd
        data={buildBreadcrumbSchema(crumbs.map((c) => ({ name: c.name, urlRelative: c.href })))}
      />
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-10 max-w-5xl">
        <Breadcrumbs items={crumbs} />
        <h1 className="text-3xl sm:text-4xl font-bold text-ink tracking-tight">
          Compare platforms
        </h1>
        <p className="mt-3 max-w-2xl text-lg text-ink-2">
          These pages compare NuraVolt with alternative tools and approaches as of July 2026,
          based on public vendor documentation. Where a competitor is the better fit for a use
          case, we say so.
        </p>
        <div className="mt-8">
          <ContentCatalogGrid cards={cards} />
        </div>
      </div>
    </PublicLayout>
  );
}
