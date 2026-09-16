'use client';

import { useState } from 'react';

interface ToolPart {
  type: string;
  toolCallId?: string;
  state?: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

export function ToolCallCard({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const toolName = part.type.replace(/^tool-/, '');
  const state = part.state ?? 'input-streaming';

  const label =
    state === 'output-available'
      ? 'Done'
      : state === 'output-error'
      ? 'Error'
      : 'Running…';

  const dotClass =
    state === 'output-available'
      ? 'bg-emerald-500'
      : state === 'output-error'
      ? 'bg-red-500'
      : 'bg-amber-500 animate-pulse';

  return (
    <div className="my-2 rounded-md border border-gray-200 bg-gray-50 text-xs">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-gray-700 hover:bg-gray-100"
      >
        <span className={`h-2 w-2 rounded-full ${dotClass}`} />
        <span className="font-mono text-gray-900">{toolName}</span>
        <span className="ml-auto text-gray-500">{label}</span>
        <span className="text-gray-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-gray-200 px-3 py-2 font-mono text-[11px]">
          {part.input != null && (
            <div>
              <div className="mb-1 text-gray-500">input</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all text-gray-700">
                {JSON.stringify(part.input, null, 2)}
              </pre>
            </div>
          )}
          {part.output != null && (
            <div>
              <div className="mb-1 text-gray-500">output</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all text-gray-700">
                {JSON.stringify(part.output, null, 2)}
              </pre>
            </div>
          )}
          {part.errorText && (
            <div className="text-red-600">{part.errorText}</div>
          )}
        </div>
      )}
    </div>
  );
}
