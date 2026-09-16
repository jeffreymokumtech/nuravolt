import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { RelatedLink } from '@/data/content/types';

/**
 * RelatedLinks, the "See also" grid. Internal linking is the multiplier that
 * spreads crawl/authority across the catalog, so every content page links to
 * its neighbours.
 */
export default function RelatedLinks({ links }: { links: RelatedLink[] }) {
  if (!links.length) return null;
  return (
    <section className="mt-12 border-t border-divider pt-8">
      <h2 className="text-lg font-semibold text-ink mb-4">See also</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="group rounded-lg border border-divider bg-paper p-4 transition-colors hover:border-primary/40 hover:bg-paper-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-ink group-hover:text-primary transition-colors">
                {link.title}
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-ink-3 group-hover:text-primary transition-colors" />
            </div>
            {link.description && (
              <p className="mt-1 text-sm text-ink-3">{link.description}</p>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}
