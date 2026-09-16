import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getSEOTags } from '@/libs/seo';
import ContentArticleLayout from '@/components/content/ContentArticleLayout';
import { faults, getFault, normalizeFault } from '@/data/content/faults';
import { metaDescription } from '@/data/content/types';

export function generateStaticParams() {
  return faults.map((f) => ({ fault: f.slug }));
}

export const dynamicParams = false;

export function generateMetadata({ params }: { params: { fault: string } }): Metadata {
  const entry = getFault(params.fault);
  if (!entry) return getSEOTags({ title: 'Fault not found | NuraVolt' });
  return getSEOTags({
    title: `${entry.title} | NuraVolt`,
    description: metaDescription(entry.quickAnswer),
    canonicalUrlRelative: `/faults/${entry.slug}`,
    keywords: [entry.title, 'fault detection', entry.category === 'bess' ? 'BESS' : 'solar PV', 'SCADA', 'predictive maintenance'],
  });
}

export default function FaultPage({ params }: { params: { fault: string } }) {
  const entry = getFault(params.fault);
  if (!entry) notFound();
  return <ContentArticleLayout article={normalizeFault(entry)} />;
}
