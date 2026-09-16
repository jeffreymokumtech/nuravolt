'use client';

import { type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { RichToolCard } from './RichToolCard';
import { usePlantRoutePrefix } from '@/utils/routePrefix';
import { useScriptedLinksInert } from '@/components/chat/demo/ScriptedThreadContext';

/**
 * Compact link-tables for listPlants / listInverters / listTickets outputs —
 * chat bubbles are narrow (rail can be 320px), so this is deliberately NOT
 * OpsTable: 2-4 columns, 11px text, max 8 rows + "+N more". Row links use
 * usePlantRoutePrefix() so they stay on the caller's surface (never /demo on
 * the dashboard) and navigate via router.push like the cite chips.
 */

const MAX_ROWS = 8;

interface TableRow {
  key: string;
  cells: ReactNode[];
  href?: string;
}

function InlineTable({
  title,
  raw,
  headers,
  rows,
  totalCount,
}: {
  title: string;
  raw: unknown;
  headers: string[];
  rows: TableRow[];
  totalCount: number;
}) {
  const router = useRouter();
  // Scripted replays on the dashboard render rows without links — the demo
  // plant slugs do not exist for the viewer's org.
  const linksInert = useScriptedLinksInert();
  if (rows.length === 0) return null;
  const shown = rows
    .slice(0, MAX_ROWS)
    .map((row) => (linksInert ? { ...row, href: undefined } : row));

  return (
    <RichToolCard title={title} raw={raw}>
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="text-left text-[10px] text-gray-500">
            {headers.map((h) => (
              <th key={h} className="pb-1 pr-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.key} className="border-t border-gray-100">
              {row.cells.map((cell, i) => (
                <td key={i} className="py-1 pr-2 align-top text-gray-800">
                  {i === 0 && row.href ? (
                    <button
                      type="button"
                      onClick={() => router.push(row.href!)}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      {cell}
                    </button>
                  ) : (
                    cell
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {totalCount > shown.length && (
        <div className="mt-1 text-[10px] text-gray-500">+{totalCount - shown.length} more</div>
      )}
    </RichToolCard>
  );
}

export function PlantListResult({ output }: { output: any }) {
  const prefix = usePlantRoutePrefix();
  const plants = Array.isArray(output?.plants) ? output.plants : [];
  return (
    <InlineTable
      title={`Plants · ${output?.count ?? plants.length}`}
      raw={output}
      headers={['Plant', 'Type', 'MW', 'Status']}
      totalCount={plants.length}
      rows={plants.map((p: any) => ({
        key: p.slug ?? p.id,
        href: p.slug ? `${prefix}/plant/${p.slug}` : undefined,
        cells: [
          p.name ?? p.slug,
          p.asset_type ?? '',
          p.capacity_mw != null ? Number(p.capacity_mw).toFixed(1) : '',
          (p.status ?? '').toLowerCase(),
        ],
      }))}
    />
  );
}

export function InverterListResult({ output }: { output: any }) {
  const prefix = usePlantRoutePrefix();
  const inverters = Array.isArray(output?.inverters) ? output.inverters : [];
  const plantSlug = output?.plant?.slug;
  return (
    <InlineTable
      title={`Inverters · ${output?.plant?.name ?? plantSlug ?? ''} · ${output?.count ?? inverters.length}`}
      raw={output}
      headers={['Inverter', 'Group', 'Model', 'kW']}
      totalCount={inverters.length}
      rows={inverters.map((inv: any) => ({
        key: inv.uuid ?? inv.id,
        href:
          plantSlug && inv.id
            ? `${prefix}/plant/${plantSlug}/inverter/${encodeURIComponent(inv.id)}`
            : undefined,
        cells: [
          inv.id ?? inv.name,
          inv.group ?? '',
          inv.model ?? '',
          inv.nominal_power_kw != null ? String(inv.nominal_power_kw) : '',
        ],
      }))}
    />
  );
}

const PRIORITY_CLASS: Record<string, string> = {
  CRITICAL: 'text-red-700',
  HIGH: 'text-red-600',
  MEDIUM: 'text-amber-600',
  LOW: 'text-gray-500',
};

export function TicketListResult({ output }: { output: any }) {
  const tickets = Array.isArray(output?.tickets) ? output.tickets : [];
  return (
    <InlineTable
      title={`Tickets · ${output?.count ?? tickets.length}`}
      raw={output}
      headers={['Ticket', 'Priority', 'Status']}
      totalCount={tickets.length}
      rows={tickets.map((t: any) => ({
        key: t.id,
        // Tickets are plant-scoped and rows carry a plant UUID, not a surface
        // slug — no reliable deep link from here, so display-only.
        cells: [
          <span key="t" className="line-clamp-2">{t.title}</span>,
          <span key="p" className={`font-medium ${PRIORITY_CLASS[t.priority] ?? 'text-gray-600'}`}>
            {(t.priority ?? '').toLowerCase()}
          </span>,
          (t.status ?? '').toLowerCase().replace(/_/g, ' '),
        ],
      }))}
    />
  );
}
