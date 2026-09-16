'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { cn } from '@/helpers/utils';
import type { ReactNode } from 'react';

/**
 * Horizontal tab strip in ops style. Active tab gets an info-tone underline
 * + bright text; inactive tabs stay muted. State sync via `?tab=` URL param
 * is opt-in (set `syncToUrl`) so direct links land on the right tab.
 */

export interface OpsTab {
  key: string;
  label: ReactNode;
  /** Optional small badge (e.g. count) rendered next to the label. */
  badge?: ReactNode;
  /** Optional status dot tone. */
  statusTone?: 'ok' | 'warn' | 'alarm' | 'info' | 'bess';
}

interface OpsTabsProps {
  tabs: OpsTab[];
  /** Controlled active tab key. */
  value?: string;
  /** Default tab key when uncontrolled. */
  defaultValue?: string;
  onChange?: (key: string) => void;
  /** Sync active tab to ?tab= URL query param. */
  syncToUrl?: boolean;
  className?: string;
}

export default function OpsTabs({
  tabs,
  value,
  defaultValue,
  onChange,
  syncToUrl,
  className,
}: OpsTabsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const initial = value ?? defaultValue ?? tabs[0]?.key ?? '';
  const [internal, setInternal] = useState(initial);
  const active = value ?? internal;

  // Hydrate from URL once on mount when sync is enabled.
  useEffect(() => {
    if (!syncToUrl) return;
    const urlTab = searchParams?.get('tab');
    if (urlTab && tabs.some((t) => t.key === urlTab) && urlTab !== active) {
      setInternal(urlTab);
      onChange?.(urlTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClick = (key: string) => {
    setInternal(key);
    onChange?.(key);
    if (syncToUrl) {
      const params = new URLSearchParams(searchParams?.toString() ?? '');
      params.set('tab', key);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }
  };

  return (
    <div
      className={cn(
        'flex items-center gap-0 border-b font-mono text-[11.5px]',
        className
      )}
      style={{ borderColor: 'var(--ops-hair)' }}
    >
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => handleClick(tab.key)}
            aria-selected={isActive}
            className="ops-tab-btn inline-flex items-center gap-1.5 px-3.5 py-2 transition-colors"
            style={{
              color: isActive ? 'var(--ops-bright)' : 'var(--ops-muted)',
              borderBottom: isActive ? '2px solid var(--ops-info)' : '2px solid transparent',
              marginBottom: -1,
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.color = 'var(--ops-bright)';
                e.currentTarget.style.background = 'var(--ops-row-hair)';
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.color = 'var(--ops-muted)';
                e.currentTarget.style.background = 'transparent';
              }
            }}
          >
            {tab.statusTone && (
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: `var(--ops-${tab.statusTone})` }}
              />
            )}
            <span>{tab.label}</span>
            {tab.badge != null && (
              <span
                className="rounded border px-1 py-px text-[9.5px]"
                style={{
                  color: isActive ? 'var(--ops-info)' : 'var(--ops-label)',
                  borderColor: 'var(--ops-row-hair)',
                  background: 'var(--ops-panel-2)',
                }}
              >
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
