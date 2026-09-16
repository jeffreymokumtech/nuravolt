import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getSEOTags } from '@/libs/seo';
import ContentArticleLayout from '@/components/content/ContentArticleLayout';
import { regions, getRegion, normalizeRegion } from '@/data/content/regions';
import { metaDescription } from '@/data/content/types';

export function generateStaticParams() {
  return regions.map((r) => ({ slug: r.slug }));
}

export const dynamicParams = false;

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const entry = getRegion(params.slug);
  if (!entry) return getSEOTags({ title: 'Country guide not found | NuraVolt' });
  return getSEOTags({
    title: `${entry.title} | NuraVolt`,
    description: metaDescription(entry.quickAnswer),
    canonicalUrlRelative: `/solar-monitoring/${entry.slug}`,
    keywords: [
      `solar monitoring ${entry.country}`,
      `PV plant monitoring ${entry.country}`,
      'solar analytics',
      'soiling monitoring',
    ],
  });
}

export default function RegionPage({ params }: { params: { slug: string } }) {
  const entry = getRegion(params.slug);
  if (!entry) notFound();
  return <ContentArticleLayout article={normalizeRegion(entry)} />;
}
