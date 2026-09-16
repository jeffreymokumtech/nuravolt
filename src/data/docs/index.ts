import type { ArticleView, RelatedLink } from '@/data/content/types';
import type { DocArticle, DocCategory, DocCategorySlug } from './types';
import { docUrl } from './types';
import { gettingStartedArticles } from './getting-started';
import { connectingDataArticles } from './connecting-data';
import { analyticsArticles } from './analytics';
import { teamAndRolesArticles } from './team-and-roles';
import { billingArticles } from './billing';
import { aiAndApiArticles } from './ai-and-api';

export const DOC_CATEGORIES: DocCategory[] = [
  {
    slug: 'getting-started',
    label: 'Getting started',
    description: 'Create your account, onboard your first plant, and find your way around.',
  },
  {
    slug: 'connecting-data',
    label: 'Connecting data',
    description: 'Inverter clouds, SCADA, files, and how your credentials are protected.',
  },
  {
    slug: 'analytics',
    label: 'Plants and analytics',
    description: 'Soiling intelligence, fault detection, tickets, and how models mature.',
  },
  {
    slug: 'team-and-roles',
    label: 'Team and roles',
    description: 'Invitations, roles, permissions, and per-plant access.',
  },
  {
    slug: 'billing',
    label: 'Billing',
    description: 'Plans, capacity bands, upgrades and cancellation.',
  },
  {
    slug: 'ai-and-api',
    label: 'AI and API',
    description: 'The MCP server: your NuraVolt data inside AI assistants.',
  },
];

export const DOC_ARTICLES: DocArticle[] = [
  ...gettingStartedArticles,
  ...connectingDataArticles,
  ...analyticsArticles,
  ...teamAndRolesArticles,
  ...billingArticles,
  ...aiAndApiArticles,
];

export function getDocCategory(slug: string): DocCategory | undefined {
  return DOC_CATEGORIES.find((c) => c.slug === slug);
}

export function getDocArticle(category: string, slug: string): DocArticle | undefined {
  return DOC_ARTICLES.find((a) => a.category === category && a.slug === slug);
}

export function docsByCategory(category: DocCategorySlug): DocArticle[] {
  return DOC_ARTICLES.filter((a) => a.category === category);
}

/** Map a DocArticle to the shared ArticleView rendered by ContentArticleLayout. */
export function normalizeDoc(entry: DocArticle): ArticleView {
  const category = getDocCategory(entry.category);

  const related: RelatedLink[] = [
    ...(entry.relatedDocs ?? []).map((ref) => {
      const target = getDocArticle(ref.category, ref.slug);
      return {
        title: target?.title ?? ref.slug,
        href: docUrl(ref.category, ref.slug),
        description: target?.intro,
      };
    }),
    ...(entry.extraRelated ?? []),
  ];

  return {
    category: category?.label ?? 'Documentation',
    hub: { label: 'Documentation', href: '/docs' },
    slug: entry.slug,
    urlRelative: docUrl(entry.category, entry.slug),
    title: entry.title,
    intro: entry.intro,
    quickAnswer: entry.quickAnswer,
    sections: entry.sections,
    faq: entry.faq,
    related,
    datePublished: entry.datePublished,
  };
}
