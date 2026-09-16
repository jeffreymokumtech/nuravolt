'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronDown } from 'lucide-react';
import { useDemoPlants, assetTypeChip } from '@/contexts/DemoPlantContext';
import { useAnonymization } from '@/contexts/AnonymizationContext';
import { usePlantRoutePrefix, homeHrefFor } from '@/utils/routePrefix';

/**
 * Plant crumb in the command bar, upgraded to a switcher. Renders the plant
 * label; when the surface knows about more than one plant it becomes a
 * dropdown that jumps to the SAME section on the chosen plant (soiling stays
 * soiling), so moving across the fleet never bounces through home. Falls back
 * to a plain (linked) label when the plant list is empty or has one entry —
 * identical to the old crumb, which keeps /showcase and data-less surfaces
 * rendering exactly as before.
 */

interface OpsPlantSwitcherProps {
  label: string;
  plantHref?: string;
}

export default function OpsPlantSwitcher({ label, plantHref }: OpsPlantSwitcherProps) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLSpanElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const prefix = usePlantRoutePrefix();
  const { plants } = useDemoPlants();
  const { anonName } = useAnonymization();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const currentSlug = pathname?.match(/\/plant\/([^/]+)/)?.[1] ?? null;

  const switchTo = (slug: string) => {
    // Preserve the current section (up to two segments, so nested audit
    // routes survive) and the query string — same rule PlantPageChrome used.
    const m = pathname?.match(/\/plant\/[^/]+((?:\/[a-z-]+){0,2})$/);
    const sectionSuffix = m?.[1] ?? '';
    const qs = window.location.search;
    setOpen(false);
    router.push(`${prefix}/plant/${slug}${sectionSuffix}${qs}`);
  };

  // Plain crumb when there is nothing to switch between.
  if (plants.length <= 1) {
    return plantHref ? (
      <a href={plantHref} className="transition-colors hover:underline" style={{ color: 'var(--ops-txt)' }}>
        {label}
      </a>
    ) : (
      <span style={{ color: 'var(--ops-txt)' }}>{label}</span>
    );
  }

  return (
    <span className="relative inline-flex" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 transition-colors hover:underline"
        style={{ color: 'var(--ops-txt)' }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch plant"
      >
        {label}
        <ChevronDown size={11} style={{ color: 'var(--ops-muted)' }} aria-hidden />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-50 mt-1.5 max-h-80 w-64 overflow-y-auto rounded-md border py-1 font-mono text-[11px] shadow-lg"
          style={{ background: 'var(--ops-panel)', borderColor: 'var(--ops-hair)' }}
        >
          {plants.map((p) => {
            const isCurrent = p.slug === currentSlug || p.id === currentSlug;
            return (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={isCurrent}
                onClick={() => !isCurrent && switchTo(p.slug)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:brightness-110"
                style={{
                  color: isCurrent ? 'var(--ops-bright)' : 'var(--ops-txt)',
                  background: isCurrent ? 'var(--ops-nav-active-bg)' : 'transparent',
                  borderLeft: isCurrent ? '2px solid var(--ops-info)' : '2px solid transparent',
                }}
              >
                <span className="flex-1 truncate">{anonName(p.name)}</span>
                <span
                  className="rounded-sm border px-1 py-px text-[9px]"
                  style={{
                    color: 'var(--ops-info)',
                    background: 'var(--ops-info-bg)',
                    borderColor: 'var(--ops-info-border)',
                  }}
                >
                  {assetTypeChip(p.asset_type)}
                </span>
                {p.capacity_mw != null && (
                  <span style={{ color: 'var(--ops-muted)' }}>{Number(p.capacity_mw)}MW</span>
                )}
              </button>
            );
          })}
          <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--ops-hair)' }}>
            <a
              href={homeHrefFor(prefix)}
              className="block px-3 py-1.5 transition-colors hover:underline"
              style={{ color: 'var(--ops-info)' }}
            >
              View all plants →
            </a>
          </div>
        </div>
      )}
    </span>
  );
}
