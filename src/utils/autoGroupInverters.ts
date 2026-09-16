import type { DiscoveredInverter, InverterGroupConfig } from '@/types/onboarding';

export interface AutoGroupSuggestion {
  groups: InverterGroupConfig[];
  confidence: 'high' | 'medium' | 'low';
  method: string;
  message: string;
}

/**
 * Auto-detect inverter groups from discovered inverters.
 *
 * Priority order:
 * 1. API group hints (from monitoring platform)
 * 2. User-supplied regex pattern
 * 3. Naming pattern extraction
 * 4. Model/power clustering (only if models differ)
 * 5. Fallback: single group
 */
export function autoGroupInverters(
  inverters: DiscoveredInverter[],
  userRegex?: string
): AutoGroupSuggestion {
  if (inverters.length === 0) {
    return {
      groups: [],
      confidence: 'low',
      method: 'empty',
      message: 'No inverters to group.',
    };
  }

  // 1. API group hints
  const hintResult = groupByHints(inverters);
  if (hintResult) return hintResult;

  // 2. User regex
  if (userRegex) {
    const regexResult = groupByUserRegex(inverters, userRegex);
    if (regexResult) return regexResult;
  }

  // 3. Naming pattern
  const namingResult = groupByNamingPattern(inverters);
  if (namingResult) return namingResult;

  // 4. Model clustering
  const modelResult = groupByModel(inverters);
  if (modelResult) return modelResult;

  // 5. Fallback
  return {
    groups: [buildGroup('Array 1', 'array-1', inverters)],
    confidence: 'low',
    method: 'fallback',
    message: `All ${inverters.length} inverters appear identical. You can manually split them into orientation groups.`,
  };
}

/**
 * Apply a user-provided pattern to extract group keys.
 * Supports simple modes ("contains X", "starts with X") or full regex with capture group.
 */
export function groupByUserRegex(
  inverters: DiscoveredInverter[],
  pattern: string
): AutoGroupSuggestion | null {
  let regex: RegExp;

  // Simple pattern modes
  const containsMatch = pattern.match(/^contains?\s+(.+)$/i);
  const startsMatch = pattern.match(/^starts?\s+with\s+(.+)$/i);
  const endsMatch = pattern.match(/^ends?\s+with\s+(.+)$/i);

  if (containsMatch) {
    regex = new RegExp(escapeRegex(containsMatch[1]), 'i');
  } else if (startsMatch) {
    regex = new RegExp(`^${escapeRegex(startsMatch[1])}`, 'i');
  } else if (endsMatch) {
    regex = new RegExp(`${escapeRegex(endsMatch[1])}$`, 'i');
  } else {
    // Full regex — expect a capture group for the group key
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      return null;
    }
  }

  const grouped = new Map<string, DiscoveredInverter[]>();

  for (const inv of inverters) {
    const text = inv.name || inv.id;
    const match = text.match(regex);
    if (match) {
      // Use first capture group as key, or "matched" if no capture group
      const key = match[1] ?? 'matched';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(inv);
    } else {
      if (!grouped.has('unmatched')) grouped.set('unmatched', []);
      grouped.get('unmatched')!.push(inv);
    }
  }

  if (grouped.size <= 1) return null;

  const groups = Array.from(grouped.entries()).map(([key, invs]) =>
    buildGroup(`Group ${key}`, slugify(key), invs)
  );

  return {
    groups,
    confidence: 'medium',
    method: 'user_regex',
    message: `Pattern "${pattern}" found ${groups.length} groups across ${inverters.length} inverters.`,
  };
}

/**
 * Preview how a regex pattern would group inverters (for the UI).
 */
export function previewRegexGrouping(
  inverters: DiscoveredInverter[],
  pattern: string
): { groups: Array<{ key: string; inverterIds: string[] }>; error?: string } {
  const result = groupByUserRegex(inverters, pattern);
  if (!result) {
    return { groups: [], error: 'Pattern did not produce multiple groups.' };
  }
  return {
    groups: result.groups.map(g => ({
      key: g.name,
      inverterIds: g.inverterIds,
    })),
  };
}

// --- Internal heuristics ---

function groupByHints(inverters: DiscoveredInverter[]): AutoGroupSuggestion | null {
  const withHints = inverters.filter(i => i.groupHint);
  if (withHints.length < inverters.length * 0.5) return null;

  const grouped = new Map<string, DiscoveredInverter[]>();
  for (const inv of inverters) {
    const key = inv.groupHint || 'ungrouped';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(inv);
  }

  if (grouped.size <= 1) return null;

  const groups = Array.from(grouped.entries()).map(([key, invs]) =>
    buildGroup(key, slugify(key), invs)
  );

  return {
    groups,
    confidence: 'high',
    method: 'api_group_hints',
    message: `Monitoring platform provided ${groups.length} pre-configured groups.`,
  };
}

function groupByNamingPattern(inverters: DiscoveredInverter[]): AutoGroupSuggestion | null {
  // Try common naming patterns on the name or id field
  const patterns: Array<{ regex: RegExp; description: string }> = [
    // "INV-A01" → "A", "INV-B02" → "B"
    { regex: /^(?:INV|SG|HW)[-_]?([A-Z])[-_]?\d+$/i, description: 'letter prefix' },
    // "A-01", "B-02" → letter prefix
    { regex: /^([A-Z])[-_.]\d+$/i, description: 'letter-number' },
    // "1-01", "2-03" → numeric prefix
    { regex: /^(\d+)[-_.]\d+$/, description: 'numeric prefix' },
    // "PV-01.023" → "PV-01"
    { regex: /^(PV[-_]\d+)[.]\d+$/, description: 'PV-block.inverter' },
    // "Zone1-INV01" → "Zone1"
    { regex: /^(Zone\d+|Array\d+|Block\d+)[-_]/i, description: 'zone/array prefix' },
  ];

  for (const { regex, description } of patterns) {
    const grouped = new Map<string, DiscoveredInverter[]>();
    let matchCount = 0;

    for (const inv of inverters) {
      const text = inv.name || inv.id;
      const match = text.match(regex);
      if (match && match[1]) {
        const key = match[1].toUpperCase();
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(inv);
        matchCount++;
      }
    }

    // Need >50% match rate and >1 group
    if (matchCount >= inverters.length * 0.5 && grouped.size > 1) {
      const groups = Array.from(grouped.entries())
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .map(([key, invs]) => buildGroup(`Group ${key}`, slugify(key), invs));

      return {
        groups,
        confidence: 'medium',
        method: `naming_pattern:${description}`,
        message: `Detected ${groups.length} groups from ${description} pattern in device names (${matchCount}/${inverters.length} matched).`,
      };
    }
  }

  return null;
}

function groupByModel(inverters: DiscoveredInverter[]): AutoGroupSuggestion | null {
  const grouped = new Map<string, DiscoveredInverter[]>();

  for (const inv of inverters) {
    const key = `${inv.model}|${inv.nominalPower_kW}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(inv);
  }

  if (grouped.size <= 1) return null;

  const groups = Array.from(grouped.entries()).map(([key, invs], i) => {
    const [model, power] = key.split('|');
    const name = `${model} ${power}kW`;
    return buildGroup(name, slugify(name), invs);
  });

  return {
    groups,
    confidence: 'medium',
    method: 'model_clustering',
    message: `Found ${groups.length} groups based on different inverter models/ratings.`,
  };
}

// --- Helpers ---

function buildGroup(
  name: string,
  slug: string,
  inverters: DiscoveredInverter[]
): InverterGroupConfig {
  const first = inverters[0];
  return {
    groupId: slug,
    name,
    tilt: 0,       // Must be entered manually
    azimuth: 180,  // Default south-facing
    inverterIds: inverters.map(i => i.id),
    inverterModel: first?.model || '',
    inverterNominalPower_kW: first?.nominalPower_kW || 0,
    mpptCount: first?.mpptCount || 0,
    stringsPerMppt: first?.stringsPerMppt || 0,
    gammaPdc: -0.004, // Default c-Si temperature coefficient
  };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
