/**
 * QuickAnswer, the short factual answer block pinned at the top of every
 * content page. This is the unit AI assistants (ChatGPT/Perplexity/Claude)
 * tend to lift verbatim, so it must stand alone: a complete, accurate answer
 * to the page's core question in 2-4 sentences.
 */
export default function QuickAnswer({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-6 rounded-lg border border-divider border-l-4 border-l-primary bg-paper-2 p-5">
      <p className="font-mono text-meta uppercase tracking-[0.08em] text-primary mb-2">
        Quick answer
      </p>
      <p className="text-ink text-base leading-relaxed">{children}</p>
    </div>
  );
}
