#!/usr/bin/env bash
# scripts/sweep-marketing-tokens.sh <file> [<file> ...]
#
# Mechanical token-only sweep: replaces hardcoded Tailwind palette classes
# with the new instrument-grade design tokens. Pure find/replace — does NOT
# touch layout, copy, or component structure. Run on every file in the
# marketing-surface long tail to bring it into the design system.
#
# Always inspect the diff after running. Files with bg-gradient-to-*
# backgrounds need manual cleanup that a codemod can't infer.

set -uo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <file> [<file> ...]" >&2
  exit 2
fi

# Perl one-liner — \b works the same on macOS and Linux, unlike BSD sed.
apply_sweep() {
  local f="$1"
  echo "Sweeping: $f"

  perl -i -pe '
    # Neutrals → ink scale
    s/\bbg-white\b/bg-paper/g;
    s/\bbg-gray-50\b/bg-paper-2/g;
    s/\bbg-gray-100\b/bg-paper-2/g;
    s/\bbg-gray-200\b/bg-paper-2/g;
    s/\bbg-gray-300\b/bg-divider/g;
    s/\bbg-gray-(?:800|900)\b/bg-data-bg/g;

    s/\btext-gray-(?:800|900)\b/text-ink/g;
    s/\btext-gray-(?:600|700)\b/text-ink-2/g;
    s/\btext-gray-(?:300|400|500)\b/text-ink-3/g;

    s/\bborder-gray-(?:100|200|300)\b/border-divider/g;
    s/\bborder-gray-(?:800|900)\b/border-data-rule/g;

    # Brand blues used as tinted backgrounds → paper-2 (light) or primary (dark)
    s/\bbg-blue-(?:50|100|200)\b/bg-paper-2/g;
    s/\bbg-blue-(?:400|500|600|700)\b/bg-primary/g;
    s/\bbg-blue-(?:800|900)\b/bg-data-bg/g;
    # Focus ring blue → ring
    s/\bfocus:ring-blue-(?:400|500|600|700)\b/focus:ring-ring/g;
    s/\bring-blue-(?:400|500|600|700)\b/ring-ring/g;

    # Brand blues as text — light shades on dark surfaces stay light
    s/\btext-blue-(?:50|100|200)\b/text-data-fg-2/g;
    s/\btext-blue-(?:400|500|600|700)\b/text-primary/g;
    s/\btext-blue-(?:800|900)\b/text-ink/g;

    # Blue borders → divider
    s/\bborder-blue-(?:50|100|200|300|400|500|600|700)\b/border-divider/g;

    # Hover variants for blue → primary/90
    s/\bhover:bg-blue-(?:600|700|800)\b/hover:bg-primary\/90/g;
    s/\bhover:text-blue-(?:600|700|800)\b/hover:text-primary/g;

    # Slate (almost-gray)
    s/\bbg-slate-(?:50|100|200)\b/bg-paper-2/g;
    s/\bbg-slate-(?:600|700)\b/bg-data-bg-2/g;
    s/\bbg-slate-(?:800|900|950)\b/bg-data-bg/g;
    s/\btext-slate-(?:800|900|950)\b/text-ink/g;
    s/\btext-slate-(?:600|700)\b/text-ink-2/g;
    s/\btext-slate-(?:300|400|500)\b/text-ink-3/g;
    s/\btext-slate-(?:100|200)\b/text-data-fg-2/g;
    s/\bborder-slate-(?:100|200|300)\b/border-divider/g;
    s/\bborder-slate-(?:800|900|950)\b/border-data-rule/g;

    # Specific dark gradients → data-bg
    s/bg-gradient-to-(?:br|r|b|t|l|tr|tl|bl) from-(?:slate|gray|blue|indigo)-(?:8|9)\d{2} (?:via-[a-zA-Z0-9\/-]+ )?to-(?:slate|gray|blue|indigo|purple)-(?:7|8|9)\d{2}/bg-data-bg/g;
    s/bg-gradient-to-(?:br|r|b|t|l|tr|tl|bl) from-(?:blue|indigo|purple|emerald|green)-(?:5|6|7)\d{2} (?:via-[a-zA-Z0-9\/-]+ )?to-(?:blue|indigo|purple|emerald|green|teal)-(?:6|7|8|9)\d{2}/bg-primary/g;
    # Catch-all gradient — collapse to paper-2 (subtle band). Any remaining
    # gradient that needs dark/primary should be fixed manually.
    s/bg-gradient-to-(?:br|r|b|t|l|tr|tl|bl) from-[a-zA-Z0-9\/-]+ (?:via-[a-zA-Z0-9\/-]+ )?to-[a-zA-Z0-9\/-]+/bg-paper-2/g;
    s/bg-gradient-to-(?:br|r|b|t|l|tr|tl|bl)\b/bg-paper-2/g;

    # Indigo (often paired with blue in gradients) → primary
    s/\bbg-indigo-(?:500|600|700)\b/bg-primary/g;
    s/\btext-indigo-(?:500|600|700)\b/text-primary/g;

    # Off-system radii — collapse to the two we keep
    s/\brounded-2xl\b/rounded/g;
    s/\brounded-xl\b/rounded/g;
    s/\brounded-3xl\b/rounded-lg/g;

    # Off-system shadows — collapse to shadow-sm
    s/\bshadow-2xl\b/shadow-sm/g;
    s/\bshadow-xl\b/shadow-sm/g;
    s/\bshadow-lg\b/shadow-sm/g;
    s/\bshadow-md\b/shadow-sm/g;

    # State accents — emerald/green = positive, red = critical, amber/yellow = warning
    s/\btext-emerald-(?:500|600|700)\b/text-signal-positive/g;
    s/\bbg-emerald-(?:500|600|700)\b/bg-signal-positive/g;
    s/\btext-green-(?:500|600|700)\b/text-signal-positive/g;
    s/\bbg-green-(?:500|600|700)\b/bg-signal-positive/g;

    s/\btext-red-(?:500|600|700)\b/text-signal-critical/g;
    s/\bbg-red-50\b/bg-signal-critical\/5/g;
    s/\bborder-red-(?:100|200|300)\b/border-signal-critical\/40/g;

    s/\btext-yellow-(?:500|600|700)\b/text-signal-warning/g;
    s/\btext-amber-(?:500|600|700)\b/text-signal-warning/g;
    s/\bbg-yellow-50\b/bg-signal-warning\/5/g;
    s/\bbg-amber-50\b/bg-signal-warning\/5/g;
    s/\bborder-yellow-(?:100|200|300|400|500)\b/border-signal-warning\/40/g;

    # Violet/purple/rose accents — used in BatteryAnalyticsSection style places
    s/\btext-violet-(?:500|600|700)\b/text-primary/g;
    s/\bbg-violet-(?:100|500|600)\b/bg-primary/g;
    s/\btext-rose-(?:500|600|700)\b/text-signal-critical/g;
    s/\bbg-rose-(?:100|500|600)\b/bg-signal-critical/g;
  ' "$f"
}

for file in "$@"; do
  if [[ ! -f "$file" ]]; then
    echo "skip (not found): $file" >&2
    continue
  fi
  apply_sweep "$file"
done

echo ""
echo "Sweep complete. Run \`npm run check-consistency\` (after adding files to scope) to verify."
