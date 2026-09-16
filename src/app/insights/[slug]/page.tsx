import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getSEOTags } from '@/libs/seo';
import ContentArticleLayout from '@/components/content/ContentArticleLayout';
import { insights, getInsight, normalizeInsight } from '@/data/content/insights';
import { metaDescription } from '@/data/content/types';

export function generateStaticParams() {
  return insights.map((i) => ({ slug: i.slug }));
}

export const dynamicParams = false;

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const entry = getInsight(params.slug);
  if (!entry) return getSEOTags({ title: 'Insight not found | NuraVolt' });
  return getSEOTags({
    title: `${entry.title} | NuraVolt`,
    description: metaDescription(entry.quickAnswer),
    canonicalUrlRelative: `/insights/${entry.slug}`,
    keywords: [entry.title, 'solar', 'BESS', 'analytics'],
  });
}

export default function InsightPage({ params }: { params: { slug: string } }) {
  const entry = getInsight(params.slug);
  if (!entry) notFound();
  return <ContentArticleLayout article={normalizeInsight(entry)} />;
}
