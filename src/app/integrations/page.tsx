import { getSEOTags, buildBreadcrumbSchema } from '@/libs/seo';
import PublicLayout from '@/components/layouts/PublicLayout';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import Breadcrumbs from '@/components/content/Breadcrumbs';
import ContentCatalogGrid, { CatalogCard } from '@/components/content/ContentCatalogGrid';
import { integrations } from '@/data/content/integrations';

export const metadata = getSEOTags({
  title: 'Inverter & BESS vendor integrations | NuraVolt',
  description:
    'How NuraVolt ingests inverter and BESS vendor data, Huawei SUN2000, Tesla Megapack, Sungrow, over Modbus, vendor APIs and CSV, mapped to one analytics schema.',
  canonicalUrlRelative: '/integrations',
  keywords: ['solar monitoring integration', 'Huawei Modbus monitoring', 'Tesla Megapack analytics', 'Sungrow monitoring', 'SCADA integration', 'BESS telemetry'],
});

export default function IntegrationsIndexPage() {
  const crumbs = [
    { name: 'Home', href: '/' },
    { name: 'Integrations', href: '/integrations' },
  ];

  const cards: CatalogCard[] = integrations.map((i) => ({
    title: i.title,
    href: `/integrations/${i.slug}`,
    description: i.intro,
    tag: i.status === 'roadmap' ? 'Roadmap' : i.vendor,
  }));

  return (
    <PublicLayout>
      <SchemaJsonLd
        data={buildBreadcrumbSchema(crumbs.map((c) => ({ name: c.name, urlRelative: c.href })))}
      />
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-10 max-w-5xl">
        <Breadcrumbs items={crumbs} />
        <h1 className="text-3xl sm:text-4xl font-bold text-ink tracking-tight">
          Inverter &amp; BESS integrations
        </h1>
        <p className="mt-3 max-w-2xl text-lg text-ink-2">
          NuraVolt reads from your existing inverters and battery systems over Modbus, vendor
          APIs and CSV, normalises everything to a common schema, and maps vendor fault codes
          onto its physics-informed taxonomy.
        </p>
        <div className="mt-8">
          <ContentCatalogGrid cards={cards} />
        </div>
      </div>
    </PublicLayout>
  );
}
