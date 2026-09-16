import type { ArticleView, ContentSection, FAQ, RelatedLink } from '@/data/content/types';

/**
 * Types for the customer documentation catalog (/docs).
 *
 * Reuses the content-catalog primitives (ContentBlock/ContentSection/FAQ/
 * RelatedLink/ArticleView) from src/data/content/types.ts so docs articles
 * render through the same <ContentArticleLayout /> path as faults, BESS
 * metrics, integrations, and insights. Articles are pure typed data; no JSX.
 */

export type DocCategorySlug =
  | 'getting-started'
  | 'connecting-data'
  | 'analytics'
  | 'team-and-roles'
  | 'billing'
  | 'ai-and-api';

export interface DocCategory {
  slug: DocCategorySlug;
  /** Sentence-case display label, e.g. "Getting started". */
  label: string;
  description: string;
}

export interface DocArticle {
  category: DocCategorySlug;
  slug: string;
  title: string;
  /** One-line sub-headline under the H1. */
  intro: string;
  /** Short factual answer block AI engines lift. Keep under ~320 chars. */
  quickAnswer: string;
  sections: ContentSection[];
  faq: FAQ[];
  /** References to other doc articles, resolved to links at normalize time. */
  relatedDocs?: { category: DocCategorySlug; slug: string }[];
  /** Cross-site links outside /docs (e.g. /mcp/setup, /faults). */
  extraRelated?: RelatedLink[];
  datePublished?: string;
}

/** Canonical relative URL for a doc article. */
export function docUrl(category: DocCategorySlug, slug: string): string {
  return `/docs/${category}/${slug}`;
}

// Re-export the shared view type so consumers of the docs catalog only need
// one import path.
export type { ArticleView, ContentSection, FAQ, RelatedLink };
