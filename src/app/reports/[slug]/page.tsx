import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getSEOTags } from '@/libs/seo';
import ContentArticleLayout from '@/components/content/ContentArticleLayout';
import { reports, getReport, normalizeReport } from '@/data/content/reports';
import { metaDescription } from '@/data/content/types';

export function generateStaticParams() {
  return reports.map((r) => ({ slug: r.slug }));
}

export const dynamicParams = false;

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const entry = getReport(params.slug);
  if (!entry) return getSEOTags({ title: 'Report not found | NuraVolt' });
  return getSEOTags({
    title: `${entry.title} | NuraVolt`,
    description: metaDescription(entry.quickAnswer),
    canonicalUrlRelative: `/reports/${entry.slug}`,
    keywords: [entry.title, 'solar', 'PV fault detection', 'BESS', 'benchmark', 'open data'],
  });
}

export default function ReportPage({ params }: { params: { slug: string } }) {
  const entry = getReport(params.slug);
  if (!entry) notFound();
  return <ContentArticleLayout article={normalizeReport(entry)} />;
}
