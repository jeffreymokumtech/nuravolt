'use client';

import { useEffect, useRef } from 'react';
import { ArrowLeft, RotateCcw, Sparkles } from 'lucide-react';
import type { DemoThread } from '@/fixtures/demo-conversations/types';
import { Message } from '@/components/chat/Message';
import { ScriptedThreadProvider } from './ScriptedThreadContext';
import { useThreadReplay } from './useThreadReplay';

/**
 * Read-only viewer for a scripted Shams example session. Replaces ChatPanel
 * in the rail while active: typewriter replay through the real <Message>
 * renderer (rich charts, draft cards, cite chips all behave exactly as a
 * live session would) — but no useChat, no network, nothing persists.
 */
export function ScriptedThreadView({
  thread,
  siblings,
  onBack,
  onOpenThread,
}: {
  thread: DemoThread;
  /** Other threads for the same plant, for the footer chips. */
  siblings: DemoThread[];
  onBack: () => void;
  onOpenThread: (t: DemoThread) => void;
}) {
  const { visibleMessages, done, skip, replay } = useThreadReplay(thread);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visibleMessages]);

  return (
    <ScriptedThreadProvider value={true}>
      <div className="flex min-h-0 flex-1 flex-col" onClick={done ? undefined : skip}>
        <div className="flex items-center gap-2 border-b border-gray-200 bg-amber-50/60 px-3 py-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onBack();
            }}
            className="rounded-md p-1 text-gray-500 hover:bg-white hover:text-gray-900"
            aria-label="Back to chat"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <Sparkles className="h-3.5 w-3.5 text-amber-600" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold text-gray-900">{thread.title}</div>
            <div className="text-[10px] text-amber-700">Example session · {thread.plantName}</div>
          </div>
          {done ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                replay();
              }}
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-[10px] font-medium text-gray-700 hover:border-amber-400"
            >
              <RotateCcw className="h-3 w-3" />
              Replay
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                skip();
              }}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-[10px] font-medium text-gray-700 hover:border-amber-400"
            >
              Skip
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto bg-white">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-2 py-4">
            {visibleMessages.map((m) => (
              <Message key={m.id} message={m} />
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="border-t border-gray-200 bg-gray-50 px-3 py-2">
          <div className="text-[10px] text-gray-500">
            This is a scripted example session on demo data. Nothing was sent to the model and
            nothing is persisted.
          </div>
          {siblings.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {siblings.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenThread(t);
                  }}
                  className="rounded-full border border-gray-300 bg-white px-2.5 py-1 text-[10px] font-medium text-gray-700 hover:border-blue-400 hover:text-blue-700"
                >
                  {t.title}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </ScriptedThreadProvider>
  );
}
