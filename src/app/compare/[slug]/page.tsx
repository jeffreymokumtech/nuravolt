import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getSEOTags } from '@/libs/seo';
import ContentArticleLayout from '@/components/content/ContentArticleLayout';
import { comparisons, getComparison, normalizeComparison } from '@/data/content/comparisons';
import { metaDescription } from '@/data/content/types';

export function generateStaticParams() {
  return comparisons.map((c) => ({ slug: c.slug }));
}

export const dynamicParams = false;

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const entry = getComparison(params.slug);
  if (!entry) return getSEOTags({ title: 'Comparison not found | NuraVolt' });
  return getSEOTags({
    title: `${entry.title} | NuraVolt`,
    description: metaDescription(entry.quickAnswer),
    canonicalUrlRelative: `/compare/${entry.slug}`,
    keywords: [entry.title, 'solar monitoring', 'comparison', 'alternative'],
  });
}

export default function ComparisonPage({ params }: { params: { slug: string } }) {
  const entry = getComparison(params.slug);
  if (!entry) notFound();
  return <ContentArticleLayout article={normalizeComparison(entry)} />;
}
