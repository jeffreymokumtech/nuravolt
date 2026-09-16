'use client';

import { useEffect, useState } from 'react';
import { HelpCircle, MessageCircle } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { helpForKey } from '@/data/screen-help';
import { useCopilotOptional } from '@/components/copilot/CopilotProvider';

/**
 * Per-screen help: a circled ? in the command bar that opens a right-side
 * sheet with the current screen's explainer (what it shows, how to read it,
 * where the data comes from) from the typed catalog in src/data/screen-help.
 * The footer hands off to Shams with a prefilled question when the copilot
 * rail is mounted.
 */
export default function HelpButton({ helpKey }: { helpKey?: string }) {
  const [open, setOpen] = useState(false);
  const copilot = useCopilotOptional();
  const entry = helpForKey(helpKey);

  // The command palette's "About this screen" action opens the same sheet.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('nuravolt:open-help', onOpen);
    return () => window.removeEventListener('nuravolt:open-help', onOpen);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="About this screen"
        aria-label="About this screen"
        className="inline-flex items-center transition-opacity hover:opacity-75"
        style={{ color: 'var(--ops-muted)' }}
      >
        <HelpCircle size={15} aria-hidden />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="ops-light-scope w-full overflow-y-auto bg-white sm:max-w-md">
          <SheetHeader>
            <SheetTitle className="text-left text-base font-semibold text-gray-900">
              {entry.title}
            </SheetTitle>
          </SheetHeader>

          <div className="mt-4 space-y-5 text-sm text-gray-700">
            <section>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
                What this shows
              </h3>
              <p className="leading-relaxed">{entry.whatThisShows}</p>
            </section>

            <section>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
                How to read it
              </h3>
              <ul className="space-y-1.5">
                {entry.howToRead.map((line, i) => (
                  <li key={i} className="flex gap-2 leading-relaxed">
                    <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-gray-300" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="rounded-lg border border-gray-200 bg-gray-50 p-3">
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
                Where the data comes from
              </h3>
              <p className="text-[13px] leading-relaxed text-gray-600">{entry.dataProvenance}</p>
            </section>

            {entry.faq && entry.faq.length > 0 && (
              <section>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Common questions
                </h3>
                <dl className="space-y-2.5">
                  {entry.faq.map((f, i) => (
                    <div key={i}>
                      <dt className="font-medium text-gray-800">{f.q}</dt>
                      <dd className="mt-0.5 text-[13px] leading-relaxed text-gray-600">{f.a}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {copilot && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  copilot.seedNextMessage(
                    `Explain what the "${entry.title}" screen shows for the plant I am looking at, and what I should act on first.`,
                  );
                }}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
              >
                <MessageCircle size={15} aria-hidden />
                Ask Shams about this screen
              </button>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
