import { getSEOTags, buildBreadcrumbSchema } from '@/libs/seo';
import PublicLayout from '@/components/layouts/PublicLayout';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import Breadcrumbs from '@/components/content/Breadcrumbs';
import ContentCatalogGrid, { CatalogCard } from '@/components/content/ContentCatalogGrid';
import { faults } from '@/data/content/faults';

export const metadata = getSEOTags({
  title: 'PV & BESS fault library | NuraVolt',
  description:
    'A reference catalogue of solar PV and battery-storage fault modes, symptoms, SCADA signatures, root causes, impact, and how physics-informed ML detects them.',
  canonicalUrlRelative: '/faults',
  keywords: ['PV faults', 'BESS faults', 'solar fault detection', 'SCADA fault signatures', 'predictive maintenance'],
});

export default function FaultsIndexPage() {
  const crumbs = [
    { name: 'Home', href: '/' },
    { name: 'Fault library', href: '/faults' },
  ];

  const cards: CatalogCard[] = faults.map((f) => ({
    title: f.title,
    href: `/faults/${f.slug}`,
    description: f.intro,
    tag: f.category === 'bess' ? 'BESS fault' : 'PV fault',
  }));

  return (
    <PublicLayout>
      <SchemaJsonLd
        data={buildBreadcrumbSchema(crumbs.map((c) => ({ name: c.name, urlRelative: c.href })))}
      />
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-10 max-w-5xl">
        <Breadcrumbs items={crumbs} />
        <h1 className="text-3xl sm:text-4xl font-bold text-ink tracking-tight">
          PV &amp; BESS fault library
        </h1>
        <p className="mt-3 max-w-2xl text-lg text-ink-2">
          Every fault and failure mode NuraVolt detects across solar PV and battery storage, what it looks like in the data, what causes it, what it costs, and how physics-informed
          ML flags it early.
        </p>
        <div className="mt-8">
          <ContentCatalogGrid cards={cards} />
        </div>
      </div>
    </PublicLayout>
  );
}
