import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * ContentCta, the conversion target every content page links to. Content here
 * isn't a lead engine; the job of each page is to send a credible, already-warm
 * reader to the audit. Keep it understated and consistent across the catalog.
 */
export default function ContentCta() {
  return (
    <section className="mt-12 rounded-xl border border-divider bg-data-bg p-7 text-data-fg">
      <h2 className="text-xl font-semibold">See this on your own plants</h2>
      <p className="mt-2 max-w-xl text-sm text-data-fg-2">
        NuraVolt turns your SCADA and BMS data into early fault detection, degradation-aware
        BESS analytics, and audit-ready reporting. A fixed-scope audit shows you what we’d find
        on your portfolio.
      </p>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button asChild>
          <Link href="/engagements">
            Book an audit
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Link>
        </Button>
        <Button asChild variant="outline" className="border-data-fg-2/40 bg-transparent text-data-fg hover:bg-data-bg-2 hover:text-data-fg">
          <Link href="/showcase">Try the live demo</Link>
        </Button>
      </div>
    </section>
  );
}
