'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import {
  BatteryCharging,
  FileText,
  HelpCircle,
  LayoutDashboard,
  Search,
  Sparkles,
  Sun,
  Zap,
} from 'lucide-react';
import type { NavItem } from './OpsNavRail';
import { usePlantRoutePrefix } from '@/utils/routePrefix';
import { useDemoPlants } from '@/contexts/DemoPlantContext';
import { useCopilotOptional } from '@/components/copilot/CopilotProvider';

/**
 * Global command palette (Cmd+K / Ctrl+K), mounted once per shell. Groups:
 * plants (org context), screens of the current plant, inverters (fetched on
 * open), report dashboards, and actions (ask Shams with the typed query,
 * open the screen help). Client-side filtering only; cmdk does the ranking.
 */

interface PaletteProps {
  plantId?: string;
  navItems?: NavItem[];
}

export default function CommandPalette({ plantId, navItems }: PaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [inverters, setInverters] = useState<string[]>([]);
  const [reports, setReports] = useState<Array<{ id: string; title: string }>>([]);
  const router = useRouter();
  const prefix = usePlantRoutePrefix();
  const { plants } = useDemoPlants();
  const copilot = useCopilotOptional();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Lazy data on first open: current plant's inverters + report dashboards.
  useEffect(() => {
    if (!open) return;
    if (plantId && inverters.length === 0) {
      fetch(`/api/plants/${encodeURIComponent(plantId)}/inverter-groups`)
        .then((r) => (r.ok ? r.json() : null))
        .then((json) => {
          const ids = (json?.data ?? []).flatMap((g: any) =>
            (g.inverters ?? []).map((inv: any) => String(inv.external_id)),
          );
          setInverters(ids);
        })
        .catch(() => {});
    }
    if (reports.length === 0) {
      fetch('/api/dashboards')
        .then((r) => (r.ok ? r.json() : null))
        .then((json) => {
          const rows = (json?.data ?? []).map((d: any) => ({
            id: String(d.id),
            title: String(d.title ?? 'Untitled'),
          }));
          setReports(rows);
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plantId]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      setQuery('');
      router.push(href);
    },
    [router],
  );

  const askShams = useCallback(() => {
    setOpen(false);
    if (copilot) {
      copilot.seedNextMessage(query.trim() || 'Give me a quick status of this plant.');
    }
    setQuery('');
  }, [copilot, query]);

  const openHelp = useCallback(() => {
    setOpen(false);
    setQuery('');
    window.dispatchEvent(new CustomEvent('nuravolt:open-help'));
  }, []);

  const screenItems = useMemo(() => {
    if (!plantId || !navItems) return [];
    return navItems
      .filter((n) => !n.href.startsWith('/'))
      .map((n) => ({
        key: n.key,
        label: n.label,
        href: `${prefix}/plant/${plantId}${n.href ? `/${n.href}` : ''}`,
      }));
  }, [plantId, navItems, prefix]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/40 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg px-4">
        <Command
          label="Command palette"
          className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl"
        >
          <div className="flex items-center gap-2 border-b border-gray-100 px-3">
            <Search size={15} className="shrink-0 text-gray-400" aria-hidden />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Jump to a plant, screen, inverter, or report…"
              className="h-11 w-full bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400"
            />
            <kbd className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-400">
              esc
            </kbd>
          </div>
          <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
            <Command.Empty className="px-3 py-6 text-center text-sm text-gray-400">
              Nothing matches. Try a plant or screen name.
            </Command.Empty>

            {plants.length > 0 && (
              <Command.Group heading="Plants" className="cmdk-group">
                {plants.map((p) => (
                  <Command.Item
                    key={p.slug}
                    value={`plant ${p.name} ${p.slug}`}
                    onSelect={() => go(`${prefix}/plant/${p.slug}`)}
                    className="cmdk-item"
                  >
                    {p.asset_type === 'BESS' ? (
                      <BatteryCharging size={14} className="text-gray-400" aria-hidden />
                    ) : (
                      <Sun size={14} className="text-gray-400" aria-hidden />
                    )}
                    <span>{p.name}</span>
                    <span className="ml-auto text-[10px] text-gray-400">{p.asset_type}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {screenItems.length > 0 && (
              <Command.Group heading="This plant" className="cmdk-group">
                {screenItems.map((s) => (
                  <Command.Item
                    key={s.key}
                    value={`screen ${s.label}`}
                    onSelect={() => go(s.href)}
                    className="cmdk-item"
                  >
                    <LayoutDashboard size={14} className="text-gray-400" aria-hidden />
                    <span>{s.label}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {plantId && inverters.length > 0 && (
              <Command.Group heading="Inverters" className="cmdk-group">
                {inverters.map((id) => (
                  <Command.Item
                    key={id}
                    value={`inverter ${id}`}
                    onSelect={() =>
                      go(`${prefix}/plant/${plantId}/inverter/${encodeURIComponent(id)}`)
                    }
                    className="cmdk-item"
                  >
                    <Zap size={14} className="text-gray-400" aria-hidden />
                    <span className="font-mono text-[12px]">{id}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {reports.length > 0 && (
              <Command.Group heading="Reports" className="cmdk-group">
                {reports.map((r) => (
                  <Command.Item
                    key={r.id}
                    value={`report ${r.title}`}
                    onSelect={() => go(`${prefix === '/dashboard' ? '/dashboard' : '/demo'}/reports/${r.id}`)}
                    className="cmdk-item"
                  >
                    <FileText size={14} className="text-gray-400" aria-hidden />
                    <span>{r.title}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            <Command.Group heading="Actions" className="cmdk-group">
              {copilot && (
                <Command.Item value={`ask shams ${query}`} onSelect={askShams} className="cmdk-item">
                  <Sparkles size={14} className="text-gray-400" aria-hidden />
                  <span>{query.trim() ? `Ask Shams: "${query.trim()}"` : 'Ask Shams'}</span>
                </Command.Item>
              )}
              <Command.Item value="help about this screen" onSelect={openHelp} className="cmdk-item">
                <HelpCircle size={14} className="text-gray-400" aria-hidden />
                <span>About this screen</span>
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>

      <style jsx global>{`
        .cmdk-group [cmdk-group-heading] {
          padding: 6px 10px 2px;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: #9ca3af;
        }
        .cmdk-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 10px;
          border-radius: 8px;
          font-size: 13px;
          color: #111827;
          cursor: pointer;
        }
        .cmdk-item[data-selected='true'] {
          background: #eff6ff;
        }
      `}</style>
    </div>
  );
}
