import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getSEOTags } from '@/libs/seo';
import ContentArticleLayout from '@/components/content/ContentArticleLayout';
import { DOC_ARTICLES, getDocArticle, normalizeDoc } from '@/data/docs';
import { metaDescription } from '@/data/content/types';

export function generateStaticParams() {
  return DOC_ARTICLES.map((a) => ({ category: a.category, slug: a.slug }));
}

export const dynamicParams = false;

export function generateMetadata({
  params,
}: {
  params: { category: string; slug: string };
}): Metadata {
  const entry = getDocArticle(params.category, params.slug);
  if (!entry) return getSEOTags({ title: 'Documentation | NuraVolt' });
  return getSEOTags({
    title: `${entry.title} | NuraVolt Docs`,
    description: metaDescription(entry.quickAnswer),
    canonicalUrlRelative: `/docs/${entry.category}/${entry.slug}`,
    keywords: [entry.title, 'NuraVolt documentation', 'solar monitoring guide'],
  });
}

export default function DocArticlePage({
  params,
}: {
  params: { category: string; slug: string };
}) {
  const entry = getDocArticle(params.category, params.slug);
  if (!entry) notFound();
  return <ContentArticleLayout article={normalizeDoc(entry)} />;
}
