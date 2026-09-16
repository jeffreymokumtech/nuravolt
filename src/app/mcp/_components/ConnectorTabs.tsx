'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { CONNECTOR_SNIPPETS } from './snippets';

export default function ConnectorTabs() {
  const [active, setActive] = useState(CONNECTOR_SNIPPETS[0].key);
  const [copied, setCopied] = useState(false);
  const current = CONNECTOR_SNIPPETS.find((s) => s.key === active) ?? CONNECTOR_SNIPPETS[0];

  async function copyBody() {
    try {
      await navigator.clipboard.writeText(current.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard fails on insecure origins */
    }
  }

  return (
    <div className="border border-divider rounded bg-paper">
      <div className="flex overflow-x-auto border-b border-divider">
        {CONNECTOR_SNIPPETS.map((s) => {
          const isActive = s.key === active;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setActive(s.key)}
              className={`whitespace-nowrap px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-ink-2 hover:text-ink'
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      <div className="p-4 sm:p-6 space-y-3">
        {current.filename && (
          <div className="font-mono text-meta text-ink-3">{current.filename}</div>
        )}

        <div className="relative">
          <button
            type="button"
            onClick={copyBody}
            className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded border border-divider bg-paper px-2 py-1 text-xs text-ink-2 hover:bg-paper-2 hover:text-primary"
            title="Copy to clipboard"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-signal-positive" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                Copy
              </>
            )}
          </button>
          <pre className="font-mono text-meta bg-paper-2 border border-divider rounded p-4 pr-16 overflow-x-auto text-ink whitespace-pre">
            {current.body}
          </pre>
        </div>

        {current.notes && (
          <p className="text-meta text-ink-3">{current.notes}</p>
        )}

        <p className="text-meta text-ink-3">
          Replace <code className="font-mono text-ink">nv_live_YOUR_KEY_HERE</code> with a
          real key from{' '}
          <a
            href="/dashboard/settings/api-keys"
            className="text-primary underline underline-offset-2 hover:no-underline"
          >
            Settings › MCP API keys
          </a>
          .
        </p>
      </div>
    </div>
  );
}
