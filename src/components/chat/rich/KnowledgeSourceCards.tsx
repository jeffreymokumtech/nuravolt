'use client';

import { useRouter } from 'next/navigation';
import { BookOpen, ExternalLink } from 'lucide-react';
import { RichToolCard } from './RichToolCard';
import { usePlantRoutePrefix } from '@/utils/routePrefix';
import { useScriptedLinksInert } from '@/components/chat/demo/ScriptedThreadContext';

/**
 * Source cards for `tool-searchKnowledgeBase` outputs: document title,
 * segment, similarity, and the matched excerpt. On the authenticated
 * dashboard each source links into the document viewer.
 */

interface KBResult {
  document_id?: string;
  document_title: string;
  file_name?: string;
  chunk_index: number;
  similarity?: number;
  excerpt: string;
}

export function KnowledgeSourceCards({ output }: { output: { count?: number; results?: KBResult[] } }) {
  const router = useRouter();
  const surface = usePlantRoutePrefix();
  const linksInert = useScriptedLinksInert();
  const results = Array.isArray(output?.results) ? output.results : [];
  if (results.length === 0) return null;

  return (
    <RichToolCard
      title={`Knowledge base · ${results.length} source${results.length > 1 ? 's' : ''}`}
      raw={output}
    >
      <ul className="space-y-2">
        {results.map((r, i) => {
          const href =
            !linksInert && surface === '/dashboard' && r.document_id
              ? `/dashboard/kb/${encodeURIComponent(r.document_id)}#chunk-${r.chunk_index}`
              : null;
          return (
            <li key={i} className="rounded-md border border-gray-100 bg-gray-50/60 p-2">
              <div className="mb-1 flex items-center gap-1.5">
                <BookOpen className="h-3 w-3 shrink-0 text-blue-500" />
                {href ? (
                  <button
                    type="button"
                    onClick={() => router.push(href)}
                    className="truncate text-[11px] font-semibold text-blue-700 hover:underline"
                    title="Open in document viewer"
                  >
                    {r.document_title}
                  </button>
                ) : (
                  <span className="truncate text-[11px] font-semibold text-gray-800">
                    {r.document_title}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[9px] text-gray-400">
                  seg {r.chunk_index}
                  {typeof r.similarity === 'number' ? ` · ${(r.similarity * 100).toFixed(0)}%` : ''}
                </span>
                {href && <ExternalLink className="h-2.5 w-2.5 shrink-0 text-blue-400" />}
              </div>
              <p className="line-clamp-3 text-[11px] leading-snug text-gray-600">{r.excerpt}</p>
            </li>
          );
        })}
      </ul>
    </RichToolCard>
  );
}
