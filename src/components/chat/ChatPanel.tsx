'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useMemo, useRef } from 'react';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { useReportComposerOptional } from '@/components/copilot/ReportComposerContext';

interface PageContextLike {
  plantId?: string;
  inverterId?: string;
  twin?: string;
  range?: { from: string; to: string };
}

interface ChatPanelProps {
  initialMessages?: UIMessage[];
  conversationId?: string;
  /**
   * Asset / time-range scope this chat instance is currently viewing. Sent
   * with every chat turn so the system prompt and tool defaults can reference
   * it without the user typing IDs.
   */
  pageContext?: PageContextLike;
  /**
   * Pre-fill the input. Changing `nonce` re-applies the seed even if the
   * text is the same. The user must press Send manually (draft + confirm).
   */
  seed?: { text: string; nonce: number } | null;
  /** Legacy single-id prop still used by the standalone /chat page. */
  plantId?: string | null;
  /** Extra empty-state content (suggested chips, example sessions). */
  emptyState?: React.ReactNode;
}

export function ChatPanel({
  initialMessages,
  conversationId,
  pageContext,
  seed,
  plantId,
  emptyState,
}: ChatPanelProps) {
  const effectivePlantId = pageContext?.plantId ?? plantId ?? null;
  const composer = useReportComposerOptional();

  // The transport's body callback must read CURRENT values at send time.
  // useChat holds on to the transport it was initialised with, so a memoised
  // transport that closes over props goes stale — mid-conversation scope
  // changes (pinned chip, composer tags) silently never reached /api/chat.
  const bodyRef = useRef<Record<string, unknown>>({});
  bodyRef.current = {
    plantId: effectivePlantId,
    conversationId: conversationId ?? null,
    inverterId: pageContext?.inverterId ?? null,
    twin: pageContext?.twin ?? null,
    range: pageContext?.range ?? null,
    reportId: composer?.activeReportId ?? null,
  };

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        body: () => ({ ...bodyRef.current }),
      }),
    []
  );

  const { messages, sendMessage, status, error, stop, regenerate } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
  });

  const isStreaming = status === 'streaming' || status === 'submitted';

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <MessageList messages={messages} isStreaming={isStreaming} emptyState={emptyState} />

      {error && (
        <div className="border-t border-red-900/40 bg-red-950/30 px-6 py-2 text-xs text-red-300">
          <span className="font-medium">Error:</span> {error.message}
          <button
            onClick={() => regenerate()}
            className="ml-3 rounded border border-red-700 px-2 py-0.5 hover:bg-red-900/40"
          >
            Retry
          </button>
        </div>
      )}

      <MessageInput
        onSend={(text) => sendMessage({ text })}
        onStop={stop}
        isStreaming={isStreaming}
        seed={seed}
      />
    </div>
  );
}
