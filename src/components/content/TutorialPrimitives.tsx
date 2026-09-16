import { CheckCircle2, AlertTriangle } from 'lucide-react';

/**
 * TutorialPrimitives, the shared presentational helpers for step-by-step
 * tutorial pages. Extracted verbatim from src/app/mcp/setup/page.tsx so any
 * guide (MCP setup, docs tutorials) can compose the same visual language:
 * eyebrow section headings, prerequisite checklists, numbered steps, and
 * symptom/fix troubleshooting cards.
 */

export function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="mb-8 max-w-3xl">
      <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
        {eyebrow}
      </div>
      <h2 className="text-h1 font-semibold text-ink">{title}</h2>
    </div>
  );
}

export function Prereq({ label, body }: { label: string; body: string }) {
  return (
    <li className="flex gap-3">
      <CheckCircle2 className="h-5 w-5 text-signal-positive shrink-0 mt-0.5" />
      <span>
        <strong className="text-ink">{label}</strong> {body}
      </span>
    </li>
  );
}

export function Numbered({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="font-mono text-meta text-ink-3 shrink-0 w-5">{n}.</span>
      <span>{children}</span>
    </li>
  );
}

export function Trouble({ symptom, fix }: { symptom: string; fix: string }) {
  return (
    <div className="border border-divider rounded p-4 bg-paper">
      <div className="flex items-start gap-2 mb-2">
        <AlertTriangle className="h-4 w-4 text-signal-warning shrink-0 mt-0.5" />
        <code className="font-mono text-sm text-ink">{symptom}</code>
      </div>
      <p className="text-body text-ink-2 text-sm ml-6">{fix}</p>
    </div>
  );
}
