'use client';

import { useState } from 'react';
import { useCopilot, type PageContext } from '@/components/copilot/CopilotProvider';
import { Target, Info, ChevronDown, ChevronUp, MapPin, Cpu, Calendar, RotateCcw } from 'lucide-react';
import { useScopeOptions } from '@/components/chat/useScopeOptions';

const RANGE_PRESETS: Array<{ key: string; label: string; days: number }> = [
  { key: '24h', label: 'Last 24h', days: 1 },
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 90 days', days: 90 },
];

function presetToRange(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 3600 * 1000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function detectPresetKey(range: PageContext['range']): string {
  if (!range) return '';
  const ms = new Date(range.to).getTime() - new Date(range.from).getTime();
  const days = Math.round(ms / (24 * 3600 * 1000));
  return RANGE_PRESETS.find((p) => p.days === days)?.key ?? '';
}

export function AssetContextChip() {
  const {
    pageContext,
    manualScope,
    setManualScope,
    followPage,
    setFollowPage,
    resolvedScope,
    onlyThisAsset,
    setOnlyThisAsset,
  } = useCopilot();

  const [expanded, setExpanded] = useState(false);

  const { plantName, plantId, inverterId, twin, range } = resolvedScope;
  const hasAny = Boolean(plantId || inverterId || twin);
  const overridden = !followPage && !!manualScope;

  // Scope option lists (shared with MessageInput's tag palette).
  const { plants, inverters, loadingPlants, loadingInverters } = useScopeOptions(
    expanded,
    plantId
  );

  const updateScope = (patch: Partial<PageContext>) => {
    const base = manualScope ?? pageContext;
    setManualScope({ ...base, ...patch });
  };

  const resetToPage = () => {
    setManualScope(null);
    setFollowPage(true);
  };

  if (!hasAny && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-[11px] text-gray-500 italic hover:bg-gray-50 transition-colors"
      >
        <Info className="h-3 w-3" />
        No active scope, click to choose a plant.
        <ChevronDown className="ml-auto h-3 w-3" />
      </button>
    );
  }

  const parts = [
    { label: 'Plant', value: plantName ?? plantId },
    { label: 'Inverter', value: inverterId },
    { label: 'Twin', value: twin },
    { label: 'Range', value: range && `${range.from},${range.to}` },
  ].filter((p) => !!p.value);

  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 flex-wrap items-center gap-1.5 min-w-0 text-left hover:opacity-80"
          title={expanded ? 'Collapse scope' : 'Edit scope'}
        >
          <div
            className={[
              'flex items-center gap-1.5 rounded-lg px-2 py-1 ring-1',
              overridden
                ? 'bg-amber-50 text-amber-700 ring-amber-200'
                : 'bg-blue-50 text-blue-700 ring-blue-100',
            ].join(' ')}
          >
            <Target className="h-3 w-3" />
            <span className="text-[10px] font-bold uppercase tracking-tight">
              {overridden ? 'Pinned' : 'Scope'}
            </span>
          </div>

          <div className="flex items-center gap-1 min-w-0">
            {parts.map((part, i) => (
              <div key={part.label} className="flex items-center gap-1 min-w-0">
                {i > 0 && <span className="text-gray-300 text-[10px]">/</span>}
                <div className="flex flex-col min-w-0">
                  <span className="text-[8px] text-gray-400 uppercase font-bold leading-none">
                    {part.label}
                  </span>
                  <span className="text-[11px] font-semibold text-gray-700 truncate leading-tight">
                    {part.value}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {expanded ? (
            <ChevronUp className="ml-auto h-3 w-3 text-gray-400" />
          ) : (
            <ChevronDown className="ml-auto h-3 w-3 text-gray-400" />
          )}
        </button>

        {(plantId || inverterId) && !expanded && (
          <label className="flex shrink-0 cursor-pointer select-none items-center gap-2 rounded-lg border border-gray-100 bg-white px-2 py-1 transition-colors hover:bg-gray-50">
            <input
              type="checkbox"
              checked={onlyThisAsset}
              onChange={(e) => setOnlyThisAsset(e.target.checked)}
              className="h-3 w-3 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-tight">
              Isolated
            </span>
          </label>
        )}
      </div>

      {expanded && (
        <div className="mt-2.5 space-y-2 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
          {/* Plant */}
          <label className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-[9px] font-bold text-gray-500 uppercase tracking-tight">
              <MapPin className="h-3 w-3" /> Plant
            </span>
            <select
              value={plantId ?? ''}
              onChange={(e) => updateScope({
                plantId: e.target.value || undefined,
                plantName: plants.find((p) => p.slug === e.target.value || p.id === e.target.value)?.name,
                inverterId: undefined,
              })}
              disabled={loadingPlants}
              className="rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-800 focus:border-blue-400 focus:outline-none disabled:opacity-50"
            >
              <option value="">, Select plant,</option>
              {plants.map((p) => (
                <option key={p.id} value={p.slug}>{p.name}</option>
              ))}
            </select>
          </label>

          {/* Inverter */}
          <label className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-[9px] font-bold text-gray-500 uppercase tracking-tight">
              <Cpu className="h-3 w-3" /> Inverter
            </span>
            <select
              value={inverterId ?? ''}
              onChange={(e) => updateScope({ inverterId: e.target.value || undefined })}
              disabled={!plantId || loadingInverters}
              className="rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-800 focus:border-blue-400 focus:outline-none disabled:opacity-50"
            >
              <option value="">, All inverters,</option>
              {inverters.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.id}{inv.group ? ` · ${inv.group}` : ''}
                </option>
              ))}
            </select>
          </label>

          {/* Range */}
          <label className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-[9px] font-bold text-gray-500 uppercase tracking-tight">
              <Calendar className="h-3 w-3" /> Time range
            </span>
            <select
              value={detectPresetKey(range)}
              onChange={(e) => {
                const preset = RANGE_PRESETS.find((p) => p.key === e.target.value);
                updateScope({ range: preset ? presetToRange(preset.days) : undefined });
              }}
              className="rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-800 focus:border-blue-400 focus:outline-none"
            >
              <option value="">, Default,</option>
              {RANGE_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>{p.label}</option>
              ))}
            </select>
          </label>

          {/* Follow page toggle + reset */}
          <div className="flex items-center justify-between pt-1">
            <label className="flex cursor-pointer select-none items-center gap-2">
              <input
                type="checkbox"
                checked={followPage}
                onChange={(e) => setFollowPage(e.target.checked)}
                className="h-3 w-3 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-[10px] font-medium text-gray-600">
                Follow current page
              </span>
            </label>
            {overridden && (
              <button
                type="button"
                onClick={resetToPage}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700"
              >
                <RotateCcw className="h-3 w-3" /> Reset
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
