import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

export interface CatalogCard {
  title: string;
  href: string;
  description: string;
  /** Optional small tag, e.g. "PV fault", "Roadmap". */
  tag?: string;
}

/**
 * ContentCatalogGrid, the index-page grid for a hub (faults, BESS metrics,
 * integrations, insights). One card per catalog entry, optionally grouped.
 */
export default function ContentCatalogGrid({ cards }: { cards: CatalogCard[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((card) => (
        <Link
          key={card.href}
          href={card.href}
          className="group flex flex-col rounded-lg border border-divider bg-paper p-5 transition-colors hover:border-primary/40 hover:bg-paper-2"
        >
          {card.tag && (
            <span className="mb-2 inline-block w-fit rounded-sm bg-paper-2 px-2 py-0.5 font-mono text-meta uppercase tracking-[0.06em] text-ink-3 group-hover:bg-paper">
              {card.tag}
            </span>
          )}
          <h3 className="font-semibold text-ink group-hover:text-primary transition-colors">
            {card.title}
          </h3>
          <p className="mt-1.5 flex-1 text-sm text-ink-3">{card.description}</p>
          <span className="mt-3 inline-flex items-center text-sm font-medium text-primary">
            Read more
            <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </span>
        </Link>
      ))}
    </div>
  );
}
