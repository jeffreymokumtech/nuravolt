/**
 * Legacy surfaces author tile/table labels in ALL CAPS ('SOILING RATIO',
 * 'FAULT TYPE'). Normalize fully-uppercase strings to sentence case at
 * display time (same pattern as OpsCommandBar's friendlyCrumb) instead of
 * editing dozens of call sites; mixed-case strings pass through untouched.
 * Domain acronyms stay uppercase.
 */

const ACRONYMS = new Set([
  'pv', 'bess', 'scada', 'ytd', 'mtd', 'kpi', 'api', 'sr', 'rul', 'ac', 'dc',
  'rte', 'soc', 'soh', 'eol', 'ml', 'ai', 'aod', 'dq', 'id', 'rmse', 'mae',
]);

export function friendlyLabel(s: string): string {
  if (!s || /[a-z]/.test(s) || !/[A-Z]/.test(s)) return s;
  const lower = s.toLowerCase();
  const sentence = lower.charAt(0).toUpperCase() + lower.slice(1);
  return sentence.replace(/[a-zA-Z]+/g, (w) => {
    const lw = w.toLowerCase();
    if (lw === 'dod') return 'DoD';
    return ACRONYMS.has(lw) ? w.toUpperCase() : w;
  });
}
