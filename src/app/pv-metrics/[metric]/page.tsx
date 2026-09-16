import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getSEOTags } from '@/libs/seo';
import ContentArticleLayout from '@/components/content/ContentArticleLayout';
import { pvMetrics, getPvMetric, normalizePvMetric } from '@/data/content/pvMetrics';
import { metaDescription } from '@/data/content/types';

export function generateStaticParams() {
  return pvMetrics.map((m) => ({ metric: m.slug }));
}

export const dynamicParams = false;

export function generateMetadata({ params }: { params: { metric: string } }): Metadata {
  const entry = getPvMetric(params.metric);
  if (!entry) return getSEOTags({ title: 'Metric not found | NuraVolt' });
  return getSEOTags({
    title: `${entry.title} | NuraVolt`,
    description: metaDescription(entry.quickAnswer),
    canonicalUrlRelative: `/pv-metrics/${entry.slug}`,
    keywords: [entry.title, 'PV', 'solar', 'performance ratio', 'yield', 'monitoring'],
  });
}

export default function PvMetricPage({ params }: { params: { metric: string } }) {
  const entry = getPvMetric(params.metric);
  if (!entry) notFound();
  return <ContentArticleLayout article={normalizePvMetric(entry)} />;
}
