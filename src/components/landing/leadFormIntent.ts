/**
 * Bridges intent-aware CTAs across the homepage with the single lead form.
 * CTAs call goToLeadForm(intent) → scrolls to #audit-lead-form and dispatches
 * the nv:lead-intent event. AuditLeadForm listens for it and flips its mode.
 */

export type LeadIntent = 'monitoring' | 'audit' | 'foundation';

export const LEAD_INTENT_EVENT = 'nv:lead-intent';

export function goToLeadForm(intent: LeadIntent) {
  if (typeof window === 'undefined') return;
  const target = document.getElementById('audit-lead-form');
  window.dispatchEvent(new CustomEvent(LEAD_INTENT_EVENT, { detail: intent }));
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    // Pages without an embedded lead form (e.g. /solutions/*) fall back to
    // the homepage form so the CTA always lands somewhere actionable.
    window.location.href = '/#audit-lead-form';
  }
}
