import Link from 'next/link';
import { BookOpen } from 'lucide-react';
import type { DocCategorySlug } from '@/data/docs/types';

/**
 * DocLink, a subtle inline help link into the documentation at
 * /docs/{category}/{slug}. Safe to mount in both server and client
 * components (no hooks, type-only data imports). Not mounted anywhere yet;
 * drop it next to the UI it documents, e.g.
 *
 *   <DocLink category="connecting-data" slug="connect-huawei-fusionsolar">
 *     How to get Northbound credentials
 *   </DocLink>
 */
export default function DocLink({
  category,
  slug,
  children,
  className = '',
}: {
  category: DocCategorySlug;
  slug: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={`/docs/${category}/${slug}`}
      className={`inline-flex items-center gap-1 text-meta text-ink-3 underline underline-offset-2 decoration-divider hover:text-primary hover:decoration-primary transition-colors ${className}`}
    >
      <BookOpen className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </Link>
  );
}
