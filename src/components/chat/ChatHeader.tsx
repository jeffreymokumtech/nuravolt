'use client';

import { useState } from 'react';
import { Library } from 'lucide-react';
import BackLink from '@/components/ui/BackLink';
import { KnowledgeBaseDrawer } from './KnowledgeBaseDrawer';

export function ChatHeader({
  title,
  plantName,
}: {
  title?: string;
  /** Active plant context chip (from ?plant= or the conversation). */
  plantName?: string | null;
}) {
  const [kbOpen, setKbOpen] = useState(false);

  return (
    <>
      <header className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-6 py-3">
        <div className="flex items-center gap-3">
          <BackLink label="Dashboard" className="text-xs" />
          <div className="h-6 w-px bg-gray-200" />
          <div>
            <h1 className="text-sm font-semibold text-gray-900">{title ?? 'Shams'}</h1>
            <p className="text-xs text-gray-500">Your solar operations agent</p>
          </div>
          {plantName && (
            <span className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-[11px] font-medium text-blue-700">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
              {plantName}
            </span>
          )}
        </div>
        <button
          onClick={() => setKbOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700"
          title="Manage knowledge base"
        >
          <Library className="h-3.5 w-3.5" />
          Knowledge base
        </button>
      </header>
      <KnowledgeBaseDrawer open={kbOpen} onClose={() => setKbOpen(false)} />
    </>
  );
}
