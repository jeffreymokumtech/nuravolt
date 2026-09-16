import type { PageContext } from '@/components/copilot/CopilotProvider';

export type SlashResolution =
  | { kind: 'prompt'; text: string }
  | { kind: 'scope'; patch: Partial<PageContext> | null };

export interface SlashCommand {
  name: string;
  signature: string;
  description: string;
  resolve: (args: string) => SlashResolution;
}

function presetRange(days: number) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 3600 * 1000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function parseKeyValues(args: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)=("([^"]+)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args))) out[m[1]] = m[3] ?? m[4];
  return out;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/diag',
    signature: '/diag <inverter-id>',
    description: 'Diagnose an inverter using 30 days of digital-twin metrics.',
    resolve: (args) => ({
      kind: 'prompt',
      text: args.trim()
        ? `Run a diagnosis on inverter ${args.trim()} for the current plant. List the most likely fault, the supporting evidence, and the recommended next action.`
        : 'Run a diagnosis on the inverter currently in scope. List the most likely fault, the supporting evidence, and the recommended next action.',
    }),
  },
  {
    name: '/tickets',
    signature: '/tickets [status]',
    description: 'List my open tickets (optionally filter by status).',
    resolve: (args) => {
      const status = args.trim().toLowerCase();
      const valid = ['new', 'validated', 'assigned', 'in_progress', 'done'];
      const filter = valid.includes(status) ? ` with status ${status.toUpperCase()}` : '';
      return {
        kind: 'prompt',
        text: `List the tickets for the current scope${filter}. Sort by revenue impact descending and show priority, status, plant, trigger type.`,
      };
    },
  },
  {
    name: '/forecast',
    signature: '/forecast',
    description: 'Soiling forecast + cleaning recommendation for the current plant.',
    resolve: () => ({
      kind: 'prompt',
      text: 'Give me the soiling forecast and the cleaning recommendation for the current plant. Summarise the next 30 days, flag any weather-recovery events, and tell me whether cleaning is justified.',
    }),
  },
  {
    name: '/scope',
    signature: '/scope plant=<slug> [inverter=<id>] [range=24h|7d|30d|90d]',
    description: 'Pin the chat scope to a plant/inverter/range (no LLM call).',
    resolve: (args) => {
      const kv = parseKeyValues(args);
      if (!Object.keys(kv).length) return { kind: 'scope', patch: null };

      const patch: Partial<PageContext> = {};
      if (kv.plant) patch.plantId = kv.plant;
      if (kv.inverter) patch.inverterId = kv.inverter;
      if (kv.range) {
        const map: Record<string, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };
        const days = map[kv.range];
        if (days) patch.range = presetRange(days);
      }
      return { kind: 'scope', patch };
    },
  },
];

export function matchSlashCommands(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return [];
  const head = input.split(/\s+/)[0].toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(head));
}

/** Try to resolve a complete `/<cmd> <args>` line. Returns null if no match. */
export function resolveSlashLine(line: string): { command: SlashCommand; result: SlashResolution } | null {
  if (!line.startsWith('/')) return null;
  const [head, ...rest] = line.split(/\s+/);
  const cmd = SLASH_COMMANDS.find((c) => c.name === head.toLowerCase());
  if (!cmd) return null;
  return { command: cmd, result: cmd.resolve(rest.join(' ')) };
}
