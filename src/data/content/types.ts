/**
 * Shared types for the NuraVolt SEO content catalog.
 *
 * Each template (faults, BESS metrics, integrations, insights) keeps its own
 * typed array of entries. A `normalize*()` helper maps an entry to the common
 * `ArticleView` that <ContentArticleLayout /> renders, so all four templates
 * share one rendering + schema path.
 */

export interface FAQ {
  q: string;
  a: string;
}

export interface RelatedLink {
  title: string;
  href: string;
  description?: string;
}

/** A renderable block inside a section. Pure data — no JSX in the catalog. */
export type ContentBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'keyValue'; pairs: { label: string; value: string }[] }
  | { type: 'code'; text: string }
  // Data-report blocks. Tables carry the citable numbers and render as static
  // server HTML so crawlers and AI engines can lift them verbatim.
  | { type: 'table'; headers: string[]; rows: string[][]; caption?: string }
  | { type: 'stat'; items: { value: string; label: string; sub?: string }[] };

export interface ContentSection {
  heading: string;
  blocks: ContentBlock[];
}

/** The normalized shape every content page renders. */
export interface ArticleView {
  /** Category label shown above the title, e.g. "Fault library". */
  category: string;
  /** Hub this page belongs to, e.g. { label: "Fault library", href: "/faults" }. */
  hub: { label: string; href: string };
  slug: string;
  /** Fully-qualified relative path, e.g. "/faults/inverter-clipping". */
  urlRelative: string;
  title: string;
  /** Optional one-line sub-headline under the H1. */
  intro?: string;
  /** The short factual answer block AI engines lift. ≤ ~320 chars. */
  quickAnswer: string;
  sections: ContentSection[];
  faq: FAQ[];
  related: RelatedLink[];
  datePublished?: string;
  heroImage?: string;
  /** Plain-text source attributions shown in a small footnote. */
  sources?: string[];
  /**
   * Optional email-gated dataset for report pages. When present, the layout
   * renders a capture form that trades an email for the raw dataset download.
   */
  dataset?: {
    slug: string;
    title: string;
    downloadUrl: string;
    blurb: string;
  };
  /**
   * Extra JSON-LD objects appended after the standard TechArticle +
   * BreadcrumbList (+ FAQPage) set, e.g. an ItemList for listicle pages.
   */
  schemaExtras?: Record<string, any>[];
}

/** Clip text to a meta-description length at a word boundary (~155 chars). */
export function metaDescription(text: string, max = 155): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : max).trimEnd()}…`;
}
