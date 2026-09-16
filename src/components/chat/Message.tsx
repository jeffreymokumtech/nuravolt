'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { User, Bot, Copy, Check, ExternalLink } from 'lucide-react';
import type { UIMessage } from 'ai';
import { ToolCallCard } from './ToolCallCard';
import { DraftTicketCard } from '@/components/copilot/DraftTicketCard';
import { DraftScheduleCard } from '@/components/copilot/DraftScheduleCard';
import { DraftReportScheduleCard } from '@/components/copilot/DraftReportScheduleCard';
import { DraftAlarmCard } from '@/components/copilot/DraftAlarmCard';
import { DraftAlertAckCard } from '@/components/copilot/DraftAlertAckCard';
import { DraftTicketUpdateCard } from '@/components/copilot/DraftTicketUpdateCard';
import { DraftTicketCommentCard } from '@/components/copilot/DraftTicketCommentCard';
import { useScriptedLinksInert } from '@/components/chat/demo/ScriptedThreadContext';
import { splitOnCites, resolveCite } from '@/lib/ai/cite';
import { usePlantRoutePrefix } from '@/utils/routePrefix';
import { SoilingForecastResult } from './rich/SoilingForecastResult';
import { IrradianceQualityResult } from './rich/IrradianceQualityResult';
import { KnowledgeSourceCards } from './rich/KnowledgeSourceCards';
import { ChartResult } from './rich/ChartResult';
import { ReportComposerCard } from './rich/ReportComposerCard';
import { BessRevenueResult } from './rich/BessRevenueResult';
import { OptimizerRunResult } from './rich/OptimizerRunResult';
import { ClassificationResult, DiagnosisResult } from './rich/DiagnosisCard';
import {
  InverterListResult,
  PlantListResult,
  TicketListResult,
} from './rich/EntityListTable';

/**
 * Rich renderers for finished tool outputs, keyed by the AI SDK part type
 * `tool-<name>`. `canRender` is a pure shape guard (old persisted outputs or
 * empty results fall through) — components render as JSX so their hooks stay
 * legal. The collapsible-JSON ToolCallCard remains the fallback for
 * in-flight, error, unknown-tool, and unguardable shapes.
 */
const RICH_TOOL_RENDERERS: Record<
  string,
  { canRender: (output: any) => boolean; Component: (props: { output: any }) => JSX.Element | null }
> = {
  'tool-getSoilingForecast': {
    canRender: (o) => (o?.series?.dates?.length ?? 0) > 1 || (o?.preview?.length ?? 0) > 1,
    Component: SoilingForecastResult,
  },
  'tool-getChart': {
    canRender: (o) => (o?.series?.dates?.length ?? 0) > 1,
    Component: ChartResult,
  },
  'tool-createReport': {
    canRender: (o) => Boolean(o?.report_id),
    Component: ReportComposerCard,
  },
  'tool-addReportChart': {
    canRender: (o) => Boolean(o?.report_id),
    Component: ReportComposerCard,
  },
  'tool-updateReportWidget': {
    canRender: (o) => Boolean(o?.report_id),
    Component: ReportComposerCard,
  },
  'tool-removeReportWidget': {
    canRender: (o) => Boolean(o?.report_id),
    Component: ReportComposerCard,
  },
  'tool-getReport': {
    canRender: (o) => Boolean(o?.report_id),
    Component: ReportComposerCard,
  },
  'tool-getIrradianceQuality': {
    canRender: (o) =>
      typeof o?.overall?.correlation === 'number' && (o?.overall?.sample_count ?? 0) > 0,
    Component: IrradianceQualityResult,
  },
  'tool-getBessRevenue': {
    canRender: (o) =>
      (Array.isArray(o?.series) && o.series.length > 0) ||
      (o?.services != null && typeof o?.total === 'number'),
    Component: BessRevenueResult,
  },
  'tool-runCleaningOptimizer': {
    canRender: (o) => Boolean(o?.recommended?.dates?.length),
    Component: OptimizerRunResult,
  },
  'tool-getInverterClassification': {
    canRender: (o) => Boolean(o?.likelyCause),
    Component: ClassificationResult,
  },
  'tool-getInverterDiagnosis': {
    canRender: (o) => Boolean(o?.diagnosis?.summary),
    Component: DiagnosisResult,
  },
  'tool-searchKnowledgeBase': {
    canRender: (o) => Array.isArray(o?.results) && o.results.length > 0,
    Component: KnowledgeSourceCards,
  },
  'tool-listPlants': {
    canRender: (o) => Array.isArray(o?.plants) && o.plants.length > 0,
    Component: PlantListResult,
  },
  'tool-listInverters': {
    canRender: (o) => Array.isArray(o?.inverters) && o.inverters.length > 0,
    Component: InverterListResult,
  },
  'tool-listTickets': {
    canRender: (o) => Array.isArray(o?.tickets) && o.tickets.length > 0,
    Component: TicketListResult,
  },
};

function RichOrFallback({ part }: { part: any }) {
  const entry = RICH_TOOL_RENDERERS[part.type];
  if (
    entry &&
    part.state === 'output-available' &&
    part.output != null &&
    !(part.output as any).error &&
    entry.canRender(part.output)
  ) {
    return <entry.Component output={part.output} />;
  }
  return <ToolCallCard part={part} />;
}

function extractText(message: UIMessage): string {
  return message.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as any).text as string)
    .join('\n')
    .trim();
}

function RichText({ text }: { text: string }) {
  const surface = usePlantRoutePrefix();
  const router = useRouter();
  // Scripted replays on the dashboard render cite chips without links — the
  // demo plant slugs do not exist for the viewer's org.
  const linksInert = useScriptedLinksInert();
  const segments = splitOnCites(text);

  return (
    <span className="whitespace-pre-wrap">
      {segments.map((seg, i) => {
        if (seg.type === 'text') return <span key={i}>{seg.text}</span>;
        const { label, href: resolvedHref } = resolveCite(seg.cite, surface);
        const href = linksInert ? null : resolvedHref;
        if (!href) {
          return (
            <span
              key={i}
              className="mx-0.5 inline-flex items-center gap-1 rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600"
              title={seg.raw}
            >
              {label}
            </span>
          );
        }
        return (
          <button
            key={i}
            type="button"
            onClick={() => router.push(href)}
            className="mx-0.5 inline-flex items-center gap-1 rounded-md bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700 ring-1 ring-blue-100 hover:bg-blue-100"
            title={`Open: ${href}`}
          >
            <ExternalLink className="h-2.5 w-2.5" />
            {label}
          </button>
        );
      })}
    </span>
  );
}

export function Message({ message }: { message: UIMessage }) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    const text = extractText(message);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write can fail on insecure origins, silent no-op.
    }
  };

  return (
    <div className={`group flex w-full gap-3 px-4 py-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div className={`flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-full text-white shadow-sm ${
        isUser ? 'bg-blue-600' : 'bg-gray-800'
      }`}>
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>

      <div className="relative max-w-[85%]">
        <div
          className={[
            'rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm',
            isUser
              ? 'bg-blue-600 text-white rounded-tr-none'
              : 'bg-white text-gray-900 border border-gray-100 rounded-tl-none',
          ].join(' ')}
        >
          {message.parts.map((part, i) => {
            if (part.type === 'text') {
              const txt = (part as any).text as string;
              return (
                <div key={i}>
                  {isUser ? (
                    <span className="whitespace-pre-wrap">{txt}</span>
                  ) : (
                    <RichText text={txt} />
                  )}
                </div>
              );
            }

            // Specialised draft cards for the propose* tools, only render when
            // the tool has finished and produced an output.
            if (part.type === 'tool-proposeTicket') {
              const p = part as any;
              if (p.state === 'output-available' && p.output?.draft) {
                return <DraftTicketCard key={i} draft={p.output.draft} />;
              }
              return <ToolCallCard key={i} part={p} />;
            }

            if (part.type === 'tool-proposeCleaningSchedule') {
              const p = part as any;
              if (p.state === 'output-available' && p.output?.draft) {
                return <DraftScheduleCard key={i} draft={p.output.draft} />;
              }
              return <ToolCallCard key={i} part={p} />;
            }

            if (part.type === 'tool-proposeReportSchedule') {
              const p = part as any;
              if (p.state === 'output-available' && p.output?.draft) {
                return <DraftReportScheduleCard key={i} draft={p.output.draft} />;
              }
              return <ToolCallCard key={i} part={p} />;
            }

            if (part.type === 'tool-proposeAlarm') {
              const p = part as any;
              if (p.state === 'output-available' && p.output?.draft) {
                return <DraftAlarmCard key={i} draft={p.output.draft} />;
              }
              return <ToolCallCard key={i} part={p} />;
            }

            if (part.type === 'tool-proposeAlertAck') {
              const p = part as any;
              if (p.state === 'output-available' && p.output?.draft) {
                return <DraftAlertAckCard key={i} draft={p.output.draft} />;
              }
              return <ToolCallCard key={i} part={p} />;
            }

            if (part.type === 'tool-proposeTicketUpdate') {
              const p = part as any;
              if (p.state === 'output-available' && p.output?.draft) {
                return <DraftTicketUpdateCard key={i} draft={p.output.draft} />;
              }
              return <ToolCallCard key={i} part={p} />;
            }

            if (part.type === 'tool-proposeTicketComment') {
              const p = part as any;
              if (p.state === 'output-available' && p.output?.draft) {
                return <DraftTicketCommentCard key={i} draft={p.output.draft} />;
              }
              return <ToolCallCard key={i} part={p} />;
            }

            if (part.type.startsWith('tool-')) {
              return <RichOrFallback key={i} part={part as any} />;
            }

            return null;
          })}
        </div>

        {!isUser && extractText(message) && (
          <button
            type="button"
            onClick={onCopy}
            className="absolute -bottom-2 right-2 flex items-center gap-1 rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-500 opacity-0 shadow-sm transition-opacity hover:text-blue-600 group-hover:opacity-100"
            title="Copy message"
            aria-label="Copy message"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-emerald-600" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                Copy
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
