/**
 * URL-friendly dashboard slug from a title, suffixed to avoid collisions.
 * Shared by POST /api/dashboards and the chat report tools.
 */
export function slugifyDashboardTitle(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 6);
  return base ? `${base}-${suffix}` : `dashboard-${suffix}`;
}
