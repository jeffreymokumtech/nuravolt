import { ReactNode } from 'react';

/**
 * Plant route layout. Intentionally chrome-free, each child page provides
 * its own shell (OpsShell for migrated screens, PlantPageChrome for legacy
 * ones). This is so the ops-console can replace the chrome wholesale
 * without nesting double headers / nav rails.
 */
export default function PlantLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
