'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import type { UIMessage } from 'ai';
import { Message } from './Message';

interface Props {
  messages: UIMessage[];
  isStreaming: boolean;
  /** Extra content under the empty-state copy (suggested chips, examples). */
  emptyState?: ReactNode;
}

export function MessageList({ messages, isStreaming, emptyState }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center bg-white px-6">
        <div className="max-w-md text-center">
          <h2 className="mb-2 text-lg font-medium text-gray-900">
            How can I help with your plants today?
          </h2>
          <p className="text-sm text-gray-500">
            Ask about soiling forecasts, open tickets, inverter health, or recent fault detections.
            Try: <span className="text-gray-700">"What plants do I have?"</span>
          </p>
          {emptyState}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-white">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
        {messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
        {isStreaming && messages[messages.length - 1]?.role === 'user' && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
            Thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
