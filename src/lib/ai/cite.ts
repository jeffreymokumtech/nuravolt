/**
 * Inline citation grammar used in assistant messages.
 *
 * Token: [[cite:<kind>|<key1>=<val1>|<key2>=<val2>...]]
 *
 * Kinds:
 *   chart  — twin chart on an inverter page (plant, inverter, metric, [range])
 *   kb     — knowledge-base document (title, [chunk])
 *   ticket — ticket detail (id)
 *   plant  — plant overview (plant)
 *
 * The model emits these tokens inline whenever it states a value it pulled
 * from a tool, so the UI can render a clickable chip that deep-links to the
 * source view.
 */

export type CiteKind = 'chart' | 'kb' | 'ticket' | 'plant' | 'revenue';

export interface ParsedCite {
  kind: CiteKind;
  params: Record<string, string>;
  /** Raw token, for fallback rendering when params don't make sense. */
  raw: string;
}

const TOKEN_RE = /\[\[cite:([^\]]+)\]\]/g;

function decode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function parseCiteBody(body: string): ParsedCite | null {
  const segs = body.split('|').map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return null;
  const kind = segs[0].toLowerCase() as CiteKind;
  if (!['chart', 'kb', 'ticket', 'plant', 'revenue'].includes(kind)) return null;

  const params: Record<string, string> = {};
  for (const s of segs.slice(1)) {
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    params[s.slice(0, eq).trim()] = decode(s.slice(eq + 1).trim());
  }
  return { kind, params, raw: body };
}

/** Split a text run into plain segments and parsed cite tokens, in order. */
export function splitOnCites(text: string): Array<
  | { type: 'text'; text: string }
  | { type: 'cite'; cite: ParsedCite; raw: string }
> {
  const out: Array<{ type: 'text'; text: string } | { type: 'cite'; cite: ParsedCite; raw: string }> = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ type: 'text', text: text.slice(last, start) });
    const parsed = parseCiteBody(m[1]);
    // Unparseable tokens (e.g. an invented kind) are dropped rather than
    // shown raw — the token grammar is machine syntax, never user content.
    if (parsed) out.push({ type: 'cite', cite: parsed, raw: m[0] });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

/**
 * Resolve a parsed citation to a UI-renderable chip — label + optional href.
 * `surface` is the route prefix for the CURRENT surface — callers pass
 * usePlantRoutePrefix() ('/dashboard' | '/demo' | '/showcase') so chips stay
 * on the user's surface. (The old pathname sniffing defaulted everything
 * non-showcase to /demo, which pushed authenticated dashboard users into the
 * dev-only demo.)
 */
export function resolveCite(
  cite: ParsedCite,
  surface: '/dashboard' | '/demo' | '/showcase'
): { label: string; href: string | null } {

  switch (cite.kind) {
    case 'chart': {
      const { plant, inverter, metric, range } = cite.params;
      if (!plant) return { label: 'chart', href: null };
      const base = inverter
        ? `${surface}/plant/${plant}/inverter/${encodeURIComponent(inverter)}`
        : `${surface}/plant/${plant}`;
      const q = new URLSearchParams();
      if (metric) q.set('twin', metric);
      if (range) q.set('range', range);
      const qs = q.toString();
      const label = [inverter, metric].filter(Boolean).join(' · ') || plant;
      return { label, href: qs ? `${base}?${qs}` : base };
    }
    case 'plant': {
      const { plant } = cite.params;
      if (!plant) return { label: 'plant', href: null };
      return { label: plant, href: `${surface}/plant/${plant}` };
    }
    case 'ticket': {
      const { id } = cite.params;
      if (!id) return { label: 'ticket', href: null };
      return { label: `Ticket ${id}`, href: `${surface}/tickets/${encodeURIComponent(id)}` };
    }
    case 'kb': {
      const { title, chunk, doc } = cite.params;
      const label = chunk ? `${title} #${chunk}` : title || 'doc';
      // The document viewer only exists on the authenticated dashboard.
      if (doc && surface === '/dashboard') {
        const href = `/dashboard/kb/${encodeURIComponent(doc)}${chunk ? `#chunk-${chunk}` : ''}`;
        return { label, href };
      }
      return { label, href: null };
    }
    case 'revenue': {
      const { plant, service } = cite.params;
      if (!plant) return { label: 'revenue', href: null };
      const labelMap: Record<string, string> = {
        dynamic_containment: 'DC',
        dynamic_moderation: 'DM',
        dynamic_regulation: 'DR',
        balancing_mechanism: 'BM',
        capacity_market: 'CM',
        wholesale_arbitrage: 'Wholesale',
      };
      const label = service ? `${labelMap[service] ?? service} · ${plant}` : `Revenue · ${plant}`;
      const base = `${surface}/plant/${plant}/revenue`;
      const href = service ? `${base}?service=${encodeURIComponent(service)}` : base;
      return { label, href };
    }
    default:
      return { label: cite.raw, href: null };
  }
}
