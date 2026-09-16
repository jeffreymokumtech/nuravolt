import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getSEOTags } from '@/libs/seo';
import ContentArticleLayout from '@/components/content/ContentArticleLayout';
import { integrations, getIntegration, normalizeIntegration } from '@/data/content/integrations';
import { metaDescription } from '@/data/content/types';

export function generateStaticParams() {
  return integrations.map((i) => ({ vendor: i.slug }));
}

export const dynamicParams = false;

export function generateMetadata({ params }: { params: { vendor: string } }): Metadata {
  const entry = getIntegration(params.vendor);
  if (!entry) return getSEOTags({ title: 'Integration not found | NuraVolt' });
  return getSEOTags({
    title: `${entry.title} | NuraVolt`,
    description: metaDescription(entry.quickAnswer),
    canonicalUrlRelative: `/integrations/${entry.slug}`,
    keywords: [entry.vendor, 'monitoring integration', 'Modbus', 'SCADA', 'solar', 'BESS'],
  });
}

export default function IntegrationPage({ params }: { params: { vendor: string } }) {
  const entry = getIntegration(params.vendor);
  if (!entry) notFound();
  return <ContentArticleLayout article={normalizeIntegration(entry)} />;
}
