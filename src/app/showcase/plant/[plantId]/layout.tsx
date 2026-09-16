import { ReactNode } from 'react';

/**
 * Showcase plant route layout. Intentionally chrome-free (same pattern as
 * /demo/plant/[plantId]/layout.tsx): each child page provides its own shell —
 * OpsShell for the migrated screens, PlantPageChrome via AuditSectionShell /
 * SectionPageShell for legacy ones. Wrapping here again would nest a second
 * sidebar around the ops chrome (the "double menu" bug).
 */
export default function ShowcasePlantLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
