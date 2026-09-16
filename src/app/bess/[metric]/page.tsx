import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getSEOTags } from '@/libs/seo';
import ContentArticleLayout from '@/components/content/ContentArticleLayout';
import { bessMetrics, getBessMetric, normalizeBessMetric } from '@/data/content/bessMetrics';
import { metaDescription } from '@/data/content/types';

export function generateStaticParams() {
  return bessMetrics.map((m) => ({ metric: m.slug }));
}

export const dynamicParams = false;

export function generateMetadata({ params }: { params: { metric: string } }): Metadata {
  const entry = getBessMetric(params.metric);
  if (!entry) return getSEOTags({ title: 'Metric not found | NuraVolt' });
  return getSEOTags({
    title: `${entry.title} | NuraVolt`,
    description: metaDescription(entry.quickAnswer),
    canonicalUrlRelative: `/bess/${entry.slug}`,
    keywords: [entry.title, 'BESS', 'battery storage', 'degradation', 'warranty'],
  });
}

export default function BessMetricPage({ params }: { params: { metric: string } }) {
  const entry = getBessMetric(params.metric);
  if (!entry) notFound();
  return <ContentArticleLayout article={normalizeBessMetric(entry)} />;
}
