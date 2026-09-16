'use client';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import type { FAQ } from '@/data/content/types';

/**
 * FaqAccordion, visible FAQ for a content page. The matching FAQPage JSON-LD
 * is emitted separately so the answers are also machine-readable.
 */
export default function FaqAccordion({ faqs }: { faqs: FAQ[] }) {
  if (!faqs.length) return null;
  return (
    <section className="mt-12 border-t border-divider pt-8">
      <h2 className="text-lg font-semibold text-ink mb-2">Frequently asked questions</h2>
      <Accordion type="single" collapsible className="w-full">
        {faqs.map((faq, i) => (
          <AccordionItem key={i} value={`faq-${i}`} className="border-divider">
            <AccordionTrigger className="text-left text-base">{faq.q}</AccordionTrigger>
            <AccordionContent className="text-ink-2 leading-relaxed">{faq.a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}
