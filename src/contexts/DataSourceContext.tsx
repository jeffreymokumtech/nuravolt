'use client';

/**
 * DataSourceContext
 *
 * Lets sections and widgets resolve their static-data base URL without
 * hardcoding "/data". This is how /demo (internal) and /showcase (public) can
 * share the same section components — each route provides its own `dataRoot`.
 *
 * Usage:
 *   const dataRoot = useDataRoot();
 *   fetch(`${dataRoot}/soiling/${plantId}/fleet_summary.json`)
 *
 * Defaults:
 *   - Outside a provider → `/data` (backwards-compatible with all existing
 *     /data/... fetches so non-wrapped pages keep working unchanged).
 */

import { createContext, useContext, ReactNode } from 'react';

interface DataSourceContextValue {
  /** Base URL prefix for static data fetches. Default: '/data' */
  dataRoot: string;
  /**
   * When true, the page is running in the public showcase surface — components
   * can use this to hide admin/write-path features (save, delete, share, etc.).
   */
  readOnly: boolean;
}

const DEFAULT: DataSourceContextValue = {
  dataRoot: '/data',
  readOnly: false,
};

const DataSourceContext = createContext<DataSourceContextValue>(DEFAULT);

export function DataSourceProvider({
  children,
  dataRoot,
  readOnly = false,
}: {
  children: ReactNode;
  dataRoot: string;
  readOnly?: boolean;
}) {
  return (
    <DataSourceContext.Provider value={{ dataRoot, readOnly }}>
      {children}
    </DataSourceContext.Provider>
  );
}

export function useDataRoot(): string {
  return useContext(DataSourceContext).dataRoot;
}

export function useDataSource(): DataSourceContextValue {
  return useContext(DataSourceContext);
}
