'use client';

/**
 * Knowledge-base document viewer. Target of kb cite chips in Shams answers:
 * /dashboard/kb/<docId>#chunk-<n> scrolls to the cited passage. Renders the
 * ingested chunk text (PDF page fidelity is out of scope — the chunks are
 * what Shams actually read).
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { BookOpen, FileText } from 'lucide-react';
import OpsOrgShell from '@/components/ops/OpsOrgShell';

interface KBDocView {
  id: string;
  title: string;
  file_name: string;
  file_type: string;
  chunk_count: number;
  equipment_type: string | null;
  manufacturer: string | null;
  model_number: string | null;
  created_at: string;
  shared: boolean;
}

export default function KBDocumentPage() {
  const params = useParams<{ docId: string }>();
  const [doc, setDoc] = useState<KBDocView | null>(null);
  const [chunks, setChunks] = useState<Array<{ chunk_index: number; content: string }>>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');

  useEffect(() => {
    if (!params?.docId) return;
    let alive = true;
    fetch(`/api/chat/kb/${encodeURIComponent(params.docId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!alive) return;
        setDoc(d.document);
        setChunks(d.chunks ?? []);
        setState('ready');
      })
      .catch(() => {
        if (alive) setState('missing');
      });
    return () => {
      alive = false;
    };
  }, [params?.docId]);

  // Scroll to the cited chunk once content is in.
  useEffect(() => {
    if (state !== 'ready') return;
    const hash = window.location.hash;
    if (!hash) return;
    const el = document.querySelector(hash);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [state]);

  return (
    <OpsOrgShell activeNavKey="fleet" section="KNOWLEDGE BASE">
      <div className="mx-auto max-w-3xl px-6 py-8">
        {state === 'loading' && (
          <div className="py-16 text-center text-sm text-gray-400">Loading document…</div>
        )}
        {state === 'missing' && (
          <div className="py-16 text-center text-sm text-gray-500">
            Document not found or not accessible from this organization.
          </div>
        )}
        {state === 'ready' && doc && (
          <>
            <div className="mb-6 flex items-start gap-3">
              <div className="mt-1 rounded-lg bg-blue-50 p-2 text-blue-600">
                <BookOpen className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-gray-900">{doc.title}</h1>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
                  <span className="inline-flex items-center gap-1">
                    <FileText className="h-3 w-3" /> {doc.file_name}
                  </span>
                  {doc.manufacturer && (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5">{doc.manufacturer}</span>
                  )}
                  {doc.model_number && (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5">{doc.model_number}</span>
                  )}
                  {doc.shared && (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">
                      Shared library
                    </span>
                  )}
                  <span>{doc.chunk_count} segments</span>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              {chunks.map((c) => (
                <section
                  key={c.chunk_index}
                  id={`chunk-${c.chunk_index}`}
                  className="scroll-mt-24 rounded-lg border border-gray-100 bg-white p-4 target:border-amber-300 target:bg-amber-50/40"
                >
                  <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                    Segment {c.chunk_index}
                  </div>
                  <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-gray-800">
                    {c.content}
                  </pre>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </OpsOrgShell>
  );
}
