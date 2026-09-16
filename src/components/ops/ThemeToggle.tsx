'use client';

import { useOpsTheme } from '@/contexts/OpsThemeContext';

/**
 * Segmented ☀ Light / ☾ Dark toggle, sits in the command bar.
 */
export default function ThemeToggle() {
  const { theme, setTheme } = useOpsTheme();
  const isLight = theme === 'light';
  return (
    <div
      className="inline-flex rounded-lg border p-[2px] text-[10.5px]"
      style={{ borderColor: 'var(--ops-hair)', background: 'var(--ops-panel-2)' }}
    >
      <button
        type="button"
        aria-pressed={isLight}
        onClick={() => setTheme('light')}
        className="rounded-md px-2 py-[2px] transition-colors"
        style={{
          background: isLight ? 'var(--ops-nav-active-bg)' : 'transparent',
          color: isLight ? 'var(--ops-info)' : 'var(--ops-muted)',
        }}
      >
        ☀ Light
      </button>
      <button
        type="button"
        aria-pressed={!isLight}
        onClick={() => setTheme('dark')}
        className="rounded-md px-2 py-[2px] transition-colors"
        style={{
          background: !isLight ? 'var(--ops-nav-active-bg)' : 'transparent',
          color: !isLight ? 'var(--ops-info)' : 'var(--ops-muted)',
        }}
      >
        ☾ Dark
      </button>
    </div>
  );
}
