import { getSEOTags, buildBreadcrumbSchema } from '@/libs/seo';
import PublicLayout from '@/components/layouts/PublicLayout';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import Breadcrumbs from '@/components/content/Breadcrumbs';
import ContentCatalogGrid, { CatalogCard } from '@/components/content/ContentCatalogGrid';
import { reports } from '@/data/content/reports';

export const metadata = getSEOTags({
  title: 'Data reports: open solar & storage benchmarks | NuraVolt',
  description:
    'Original analysis of public solar and battery data: PV fault-detection benchmarks, remaining-useful-life accuracy, and battery end-of-life prediction. Reproducible, openly sourced, free to download.',
  canonicalUrlRelative: '/reports',
  keywords: ['solar data report', 'PV fault detection benchmark', 'open PV dataset', 'BESS RUL', 'battery end of life', 'solar analytics'],
});

export default function ReportsIndexPage() {
  const crumbs = [
    { name: 'Home', href: '/' },
    { name: 'Reports', href: '/reports' },
  ];

  const cards: CatalogCard[] = reports.map((r) => ({
    title: r.title,
    href: `/reports/${r.slug}`,
    description: r.intro,
    tag: 'Data report',
  }));

  return (
    <PublicLayout>
      <SchemaJsonLd
        data={buildBreadcrumbSchema(crumbs.map((c) => ({ name: c.name, urlRelative: c.href })))}
      />
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-10 max-w-5xl">
        <Breadcrumbs items={crumbs} />
        <h1 className="text-3xl sm:text-4xl font-bold text-ink tracking-tight">Data reports</h1>
        <p className="mt-3 max-w-2xl text-lg text-ink-2">
          Original analysis of public solar and storage data, with every number reproducible and
          openly sourced. Read the report, or download the raw dataset behind it.
        </p>
        <div className="mt-8">
          <ContentCatalogGrid cards={cards} />
        </div>
      </div>
    </PublicLayout>
  );
}
