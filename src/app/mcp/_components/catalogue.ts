/**
 * MCP tool catalogue — the customer-facing description of every tool exposed
 * by /api/mcp/mcp. Single source of truth for the landing page tool table,
 * the setup page tool reference, and docs/MCP_SERVER.md.
 *
 * If you add a tool in `src/app/api/mcp/[transport]/route.ts`, add a row here.
 */

import type { Scope } from '@/lib/mcp/scopes';

export interface CatalogueTool {
  name: string;
  purpose: string;
  scope: Scope;
  kind: 'read' | 'write';
  group: 'Plants' | 'Inverters' | 'Soiling' | 'Faults' | 'BESS' | 'Tickets' | 'Knowledge base' | 'Cleaning' | 'Reports';
}

export const CATALOGUE: CatalogueTool[] = [
  {
    name: 'nuravolt_list_plants',
    purpose: 'List every plant this key can see, with asset type, capacity, and location.',
    scope: 'plants:read',
    kind: 'read',
    group: 'Plants',
  },
  {
    name: 'nuravolt_list_inverters',
    purpose: 'List inverters at a plant, with model and rated capacity.',
    scope: 'inverters:read',
    kind: 'read',
    group: 'Inverters',
  },
  {
    name: 'nuravolt_get_soiling_forecast',
    purpose: '365-day soiling ratio forecast, confidence bounds, cleaning recommendations.',
    scope: 'soiling:read',
    kind: 'read',
    group: 'Soiling',
  },
  {
    name: 'nuravolt_get_inverter_classification',
    purpose: 'Rule-based diagnosis for one inverter — cause, confidence, ETA, recommended action.',
    scope: 'faults:read',
    kind: 'read',
    group: 'Faults',
  },
  {
    name: 'nuravolt_diagnose_inverter',
    purpose: 'Bedrock-backed 30-day digital-twin analysis. Severity, fault hypothesis, actions.',
    scope: 'diagnosis:run',
    kind: 'read',
    group: 'Faults',
  },
  {
    name: 'nuravolt_get_chart',
    purpose: 'Any-metric daily timeseries: twin predicted vs actual, energy, irradiance, soiling.',
    scope: 'plants:read',
    kind: 'read',
    group: 'Plants',
  },
  {
    name: 'nuravolt_get_irradiance_quality',
    purpose: 'On-site irradiance sensor vs reference model: correlation, bias, quality alerts.',
    scope: 'soiling:read',
    kind: 'read',
    group: 'Soiling',
  },
  {
    name: 'nuravolt_get_bess_revenue',
    purpose: 'Ancillary services + wholesale revenue breakdown for a BESS plant.',
    scope: 'bess:read',
    kind: 'read',
    group: 'BESS',
  },
  {
    name: 'nuravolt_get_warranty_position',
    purpose: 'BESS warranty position: health score, capacity floor margin, cycle budget, open violations.',
    scope: 'bess:read',
    kind: 'read',
    group: 'BESS',
  },
  {
    name: 'nuravolt_get_optimizer_audit',
    purpose: 'Dispatch benchmark against a perfect foresight optimum: capture ratio and revenue gap.',
    scope: 'bess:read',
    kind: 'read',
    group: 'BESS',
  },
  {
    name: 'nuravolt_list_tickets',
    purpose: 'Maintenance tickets with filters — plant, status, priority, limit.',
    scope: 'tickets:read',
    kind: 'read',
    group: 'Tickets',
  },
  {
    name: 'nuravolt_search_knowledge_base',
    purpose: 'Semantic search over uploaded manuals, datasheets, runbooks, incident reports.',
    scope: 'kb:read',
    kind: 'read',
    group: 'Knowledge base',
  },
  {
    name: 'nuravolt_create_ticket',
    purpose: 'Create a maintenance ticket (status NEW). Idempotency key required.',
    scope: 'tickets:write',
    kind: 'write',
    group: 'Tickets',
  },
  {
    name: 'nuravolt_update_ticket_status',
    purpose: 'Move a ticket forward: NEW → VALIDATED → ASSIGNED → IN_PROGRESS → DONE.',
    scope: 'tickets:write',
    kind: 'write',
    group: 'Tickets',
  },
  {
    name: 'nuravolt_comment_on_ticket',
    purpose: 'Add a comment. Attributed to the API key so the timeline shows the AI source.',
    scope: 'tickets:write',
    kind: 'write',
    group: 'Tickets',
  },
  {
    name: 'nuravolt_schedule_report',
    purpose: 'Create a recurring email report schedule (portfolio PDF at 07:00 UTC).',
    scope: 'reports:write',
    kind: 'write',
    group: 'Reports',
  },
  {
    name: 'nuravolt_approve_cleaning_schedule',
    purpose: 'Persist a cleaning schedule with dates + economics. Auto-computes ROI + payback.',
    scope: 'cleaning:write',
    kind: 'write',
    group: 'Cleaning',
  },
];

export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  'plants:read': 'List and view plant metadata.',
  'inverters:read': 'List and view inverters at a plant.',
  'soiling:read': 'Query soiling forecasts and recovery windows.',
  'bess:read': 'Query BESS revenue, warranty position and dispatch optimizer audit.',
  'faults:read': 'Deterministic rule-based fault classifier.',
  'tickets:read': 'List and view maintenance tickets.',
  'kb:read': 'Semantic search over uploaded knowledge base.',
  'diagnosis:run': 'Run AI diagnosis on an inverter (paid inference).',
  'tickets:write': 'Create tickets, transition status, add comments.',
  'cleaning:write': 'Persist a cleaning schedule with ROI economics.',
  'reports:write': 'Create recurring email report schedules.',
};
