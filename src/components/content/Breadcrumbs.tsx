import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

/**
 * Marketing breadcrumb for content pages. Visual trail only, the matching
 * BreadcrumbList JSON-LD is emitted separately via SchemaJsonLd so search and
 * AI engines get the structured version.
 */
export default function Breadcrumbs({
  items,
}: {
  items: { name: string; href: string }[];
}) {
  return (
    <nav aria-label="Breadcrumb" className="mb-6">
      <ol className="flex flex-wrap items-center gap-1.5 text-meta text-ink-3">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={item.href} className="flex items-center gap-1.5">
              {isLast ? (
                <span className="text-ink-2" aria-current="page">
                  {item.name}
                </span>
              ) : (
                <Link href={item.href} className="hover:text-ink transition-colors">
                  {item.name}
                </Link>
              )}
              {!isLast && <ChevronRight className="h-3 w-3 text-ink-3/60" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
