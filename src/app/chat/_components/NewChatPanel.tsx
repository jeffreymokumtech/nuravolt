'use client';

import { useState } from 'react';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { ScriptedThreadView } from '@/components/chat/demo/ScriptedThreadView';
import { ExampleSessions } from '@/components/chat/demo/ExampleSessions';
import type { DemoThread } from '@/fixtures/demo-conversations/types';
import {
  SuggestedQuestionChips,
  questionsFor,
} from '@/components/copilot/SuggestedQuestions';

/**
 * New-conversation panel for the /chat landing page. useChat needs a STABLE
 * conversation id — with `id: undefined` the chat instance resets across
 * renders and optimistic messages never render (turns still hit the API and
 * were silently lost from the UI). Same pattern as CopilotRail: generate a
 * uuid client-side once; /api/chat's ensureConversation() creates the row on
 * the first turn.
 *
 * Suggested chips pre-fill the input via ChatPanel's seed prop (no
 * CopilotProvider exists on this page). The flagship example sessions replay
 * inline via ScriptedThreadView (provider-free, no network).
 */
export function NewChatPanel({ plantId }: { plantId: string | null }) {
  const [conversationId] = useState(
    () =>
      (globalThis.crypto?.randomUUID?.() ??
        `cnv-${Date.now()}-${Math.random().toString(36).slice(2)}`) as string
  );
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);
  const [demoThreads, setDemoThreads] = useState<DemoThread[]>([]);
  const [activeDemoThread, setActiveDemoThread] = useState<DemoThread | null>(null);

  if (activeDemoThread) {
    return (
      <ScriptedThreadView
        thread={activeDemoThread}
        siblings={demoThreads.filter((t) => t.id !== activeDemoThread.id)}
        onBack={() => setActiveDemoThread(null)}
        onOpenThread={(t) => setActiveDemoThread(t)}
      />
    );
  }

  return (
    <ChatPanel
      conversationId={conversationId}
      plantId={plantId}
      seed={seed}
      emptyState={
        <>
          <ExampleSessions
            plantSlug={plantId}
            onOpen={(threads, thread) => {
              setDemoThreads(threads);
              setActiveDemoThread(thread);
            }}
          />
          <div className="mt-3">
            <SuggestedQuestionChips
              questions={questionsFor({ plantName: plantId ?? undefined })}
              onPick={(text) => setSeed({ text, nonce: Date.now() })}
            />
          </div>
        </>
      }
    />
  );
}
