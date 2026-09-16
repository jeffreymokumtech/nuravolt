'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { MarketingSection } from '@/components/ui/MarketingSection';

interface BlogArticle {
  id: string;
  title: string;
  excerpt: string;
  slug: string;
  date: string;
  category: string;
}

const articles: BlogArticle[] = [
  {
    id: 'bms-monitoring-not-enough-2026',
    title: 'Why cell-level BMS monitoring is no longer enough in 2026',
    excerpt:
      'The failures putting BESS assets at risk increasingly live in the balance-of-system, cooling, HVAC, connections, which the BMS was never designed to see.',
    slug: 'bms-monitoring-not-enough-2026',
    date: 'June 2026',
    category: 'BESS',
  },
  {
    id: 'augment-vs-overbuild',
    title: 'Augment or overbuild? How analytics defers the spend',
    excerpt:
      'Augmentation timing is one of the biggest line items in a storage business case, and it is set by your real degradation rate, not the warranty’s conservative curve.',
    slug: 'augment-vs-overbuild',
    date: 'June 2026',
    category: 'BESS',
  },
  {
    id: 'clipping-hides-soiling',
    title: 'How inverter clipping hides your soiling losses',
    excerpt:
      'When an inverter is clipping, moderate soiling and string losses can vanish from the AC data, the plant looks stable while yield quietly leaks under the cap.',
    slug: 'clipping-hides-soiling',
    date: 'June 2026',
    category: 'PV Monitoring',
  },
  {
    id: 'leading-with-bess-2026',
    title: 'Why we’re leading with BESS in 2026, and the warranty mistake we keep seeing',
    excerpt:
      'Battery storage is where the operational money and risk now sit. The recurring mistake: treating the warranty as a filed document instead of a live data position.',
    slug: 'leading-with-bess-2026',
    date: 'June 2026',
    category: 'BESS',
  },
  {
    id: 'iberian-blackout-bess-readiness',
    title: 'What the Iberian blackout exposed about BESS readiness',
    excerpt:
      'The April 2025 Iberian blackout was a stress test for storage. The assets that came through best belonged to operators who already knew their batteries’ real state.',
    slug: 'iberian-blackout-bess-readiness',
    date: 'June 2026',
    category: 'BESS',
  },
  {
    id: 'soiling-season-field-note',
    title: 'Soiling season is here: a field note on when cleaning actually pays',
    excerpt:
      'It’s June, the rain has stopped across Iberia and the Gulf, and soiling is climbing. A short note on resisting the fixed-calendar clean and letting the numbers decide.',
    slug: 'soiling-season-field-note',
    date: 'June 2026',
    category: 'PV Monitoring',
  },
];

export default function LatestBlogPosts() {
  return (
    <MarketingSection size='default'>
      <div className='flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-10 max-w-6xl mx-auto'>
        <div>
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            Insights
          </div>
          <h2 className='text-h1 font-semibold text-ink'>Latest writing</h2>
        </div>
        <Button asChild variant='outline'>
          <Link href='/blog'>
            All posts
            <ArrowRight className='w-3.5 h-3.5 ml-1.5' />
          </Link>
        </Button>
      </div>

      <div className='max-w-6xl mx-auto border-t border-divider'>
        {articles.map((article) => (
          <Link
            key={article.id}
            href={`/blog/${article.slug}`}
            className='block border-b border-divider py-7 hover:bg-paper-2 transition-colors group'
          >
            <div className='grid grid-cols-1 md:grid-cols-[140px_1fr_auto] gap-x-6 gap-y-2 items-baseline'>
              <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3'>
                {article.date} · {article.category}
              </div>
              <div>
                <h3 className='text-h2 font-semibold text-ink mb-2 group-hover:text-primary transition-colors'>
                  {article.title}
                </h3>
                <p className='text-body text-ink-2 max-w-2xl'>{article.excerpt}</p>
              </div>
              <ArrowRight className='w-4 h-4 text-ink-3 group-hover:text-ink group-hover:translate-x-1 transition-all hidden md:inline' />
            </div>
          </Link>
        ))}
      </div>
    </MarketingSection>
  );
}
