import { CheckCircle2, Zap, MessageSquare, Terminal } from 'lucide-react';

/**
 * Static mockup of an AI assistant calling NuraVolt tools. Purely presentational
 * — mirrors the in-app CopilotRail bubble/tool-card patterns so the "product in
 * AI" story looks like the same product, just running in a different host.
 */
export default function ChatMock() {
  return (
    <div className="border border-divider rounded-lg bg-paper shadow-sm overflow-hidden">
      <header className="flex items-center justify-between border-b border-divider bg-paper-2 px-4 py-2.5">
        <div className="flex items-center gap-2 text-ink-2">
          <MessageSquare className="h-4 w-4" />
          <span className="text-sm font-medium">Claude Desktop</span>
        </div>
        <span className="rounded-full bg-signal-positive/15 px-2 py-0.5 text-[10px] font-medium text-signal-positive">
          NuraVolt connected
        </span>
      </header>

      <div className="space-y-3 p-4">
        {/* User bubble */}
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-tr-none bg-primary px-4 py-2.5 text-sm text-white shadow-sm">
            NuraVolt, what&apos;s eating Sapphire Ridge&apos;s RTE this week?
          </div>
        </div>

        {/* Tool call cards */}
        <ToolCard name="nuravolt_list_plants" ok />
        <ToolCard name="nuravolt_get_bess_revenue" ok />
        <ToolCard name="nuravolt_diagnose_inverter" ok emphasis />

        {/* Assistant bubble */}
        <div className="flex">
          <div className="max-w-[92%] rounded-2xl rounded-tl-none border border-divider bg-paper px-4 py-2.5 text-sm text-ink shadow-sm">
            <p className="mb-2">
              Rack <span className="font-mono">R-07-14</span> is running{' '}
              <strong className="text-signal-critical">+4.2°C</strong> hotter than the block
              median. Round-trip efficiency dropped{' '}
              <strong className="text-signal-critical">1.8 pts</strong> — that&apos;s roughly{' '}
              <strong>$185k/yr</strong> at your current merchant + capacity mix.
            </p>
            <p className="mb-2 text-ink-2">
              No alarm tripped because the rack is still under thermal cutoff — but SoH will
              drop ~2× the fleet average if this continues. Recommend inspection within 72
              hours; draft ticket ready to create.
            </p>
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              <Pill>Plant · Sapphire Ridge</Pill>
              <Pill>Block · B-07</Pill>
              <Pill>Rack · R-07-14</Pill>
              <Pill>Range · 7d</Pill>
            </div>
          </div>
        </div>
      </div>

      <footer className="border-t border-divider bg-paper-2 px-4 py-2 text-meta text-ink-3">
        3 tools · 340 ms · 12.4k input tokens · $0.008 estimated
      </footer>
    </div>
  );
}

function ToolCard({
  name,
  ok,
  emphasis,
}: {
  name: string;
  ok?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded border px-3 py-2 text-xs font-mono ${
        emphasis
          ? 'border-primary/40 bg-primary/5 text-primary'
          : 'border-divider bg-paper-2 text-ink-2'
      }`}
    >
      {ok ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-signal-positive" />
      ) : (
        <Zap className="h-3.5 w-3.5 text-primary" />
      )}
      <span>{name}</span>
      <Terminal className="ml-auto h-3 w-3 opacity-50" />
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-paper-2 border border-divider px-1.5 py-0.5 text-ink-2">
      {children}
    </span>
  );
}
