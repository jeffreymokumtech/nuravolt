'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, ExternalLink, PanelRight } from 'lucide-react';
import { RichToolCard } from './RichToolCard';
import { useReportComposerOptional } from '@/components/copilot/ReportComposerContext';
import { useIsScriptedThread } from '@/components/chat/demo/ScriptedThreadContext';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

/**
 * Render for the report-composition tool outputs (createReport,
 * addReportChart, updateReportWidget, removeReportWidget, getReport).
 * Shows the report's current shape and syncs the composer context: sets the
 * active report and pops the drawer so the user sees the live state.
 */

interface ReportSummary {
  report_id: string;
  slug?: string;
  title: string;
  widget_count: number;
  widgets?: Array<{
    id: string;
    type: string;
    title: string | null;
    plant: string | null;
    device: string | null;
    metric: string | null;
    range: string | null;
  }>;
}

export function ReportComposerCard({ output }: { output: ReportSummary }) {
  const composer = useReportComposerOptional();
  const scripted = useIsScriptedThread();
  const surface = usePlantRoutePrefix();
  const router = useRouter();

  // Sync the composer to the report this tool just touched. Keyed on
  // report_id + widget_count so drawer refetches follow every mutation.
  useEffect(() => {
    if (scripted || !composer || !output?.report_id) return;
    composer.setActiveReport(output.report_id);
    composer.bumpRefresh();
    composer.setDrawerOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output?.report_id, output?.widget_count, scripted]);

  if (!output?.report_id) return null;

  const widgets = output.widgets ?? [];
  const editorHref = `${surface === '/showcase' ? '/demo' : surface}/reports/${output.report_id}`;

  return (
    <RichToolCard
      title={
        <span className="inline-flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5 text-blue-600" />
          {output.title}
        </span>
      }
      badge={`${output.widget_count} widget${output.widget_count === 1 ? '' : 's'}`}
      raw={output}
    >
      {widgets.length > 0 ? (
        <ul className="mb-2 space-y-0.5">
          {widgets.slice(0, 8).map((w) => (
            <li key={w.id} className="flex items-center gap-1.5 text-[11px] text-gray-700">
              <span className="h-1 w-1 shrink-0 rounded-full bg-gray-300" />
              <span className="truncate">
                {w.title || w.metric || w.type}
                {w.plant ? ` · ${w.device ?? w.plant}` : ''}
                {w.range ? ` · ${w.range.replace('last_', 'last ')}` : ''}
              </span>
            </li>
          ))}
          {widgets.length > 8 && (
            <li className="text-[10px] text-gray-400">+{widgets.length - 8} more</li>
          )}
        </ul>
      ) : (
        <p className="mb-2 text-[11px] text-gray-500">
          Empty report. Ask for a chart and say "add it to the report".
        </p>
      )}

      {!scripted && (
        <div className="flex items-center gap-2">
          {composer && (
            <button
              type="button"
              onClick={() => {
                composer.setActiveReport(output.report_id);
                composer.setDrawerOpen(true);
              }}
              className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-500"
            >
              <PanelRight className="h-3 w-3" /> Open composer
            </button>
          )}
          {surface !== '/showcase' && (
            <button
              type="button"
              onClick={() => router.push(editorHref)}
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1 text-[11px] text-gray-600 hover:border-blue-300 hover:text-blue-700"
            >
              <ExternalLink className="h-3 w-3" /> Full editor
            </button>
          )}
        </div>
      )}
    </RichToolCard>
  );
}
