#!/usr/bin/env bash
# Sweep demo/showcase off Tailwind gray/slate onto the marketing token system.
#
# Idempotent — re-running on already-swept files is a no-op.
# Word-boundary safe: replaces only complete utility class names, not
# substrings of other classes (e.g. `bg-gray-50` ≠ `bg-gray-500`).
#
# Source of truth for the mapping is the plan at
# /Users/jeffr/.claude/plans/compressed-brewing-lake.md §2.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGETS=(
  "$ROOT/src/app/demo"
  "$ROOT/src/app/showcase"
  "$ROOT/src/components/demo"
)

# Each line: '<old>|<new>'. Order matters where one pattern is a prefix of
# another (sed processes top to bottom).
MAP=$(cat <<'EOF'
bg-slate-50/50|bg-paper
bg-slate-50|bg-paper
bg-gray-50|bg-paper
bg-slate-100|bg-paper-2
bg-gray-100|bg-paper-2
border-slate-200|border-divider
border-gray-200|border-divider
border-slate-100|border-divider
border-gray-100|border-divider
bg-slate-200|bg-divider
bg-gray-200|bg-divider
text-slate-900|text-ink
text-gray-900|text-ink
text-slate-800|text-ink
text-gray-800|text-ink
text-slate-700|text-ink-2
text-gray-700|text-ink-2
text-slate-600|text-ink-2
text-gray-600|text-ink-2
text-slate-500|text-ink-3
text-gray-500|text-ink-3
text-slate-400|text-ink-3
text-gray-400|text-ink-3
bg-emerald-50|bg-signal-positive/10
bg-emerald-100|bg-signal-positive/10
bg-amber-50|bg-signal-warning/10
bg-amber-100|bg-signal-warning/10
bg-red-50|bg-signal-critical/10
bg-rose-50|bg-signal-critical/10
bg-red-100|bg-signal-critical/10
text-emerald-600|text-signal-positive
text-emerald-700|text-signal-positive
text-amber-600|text-signal-warning
text-amber-700|text-signal-warning
text-yellow-600|text-signal-warning
text-red-600|text-signal-critical
text-rose-600|text-signal-critical
text-emerald-800|text-signal-positive
text-amber-800|text-signal-warning
text-amber-900|text-signal-warning
text-red-700|text-signal-critical
text-red-800|text-signal-critical
text-rose-700|text-signal-critical
border-emerald-200|border-signal-positive/20
border-emerald-300|border-signal-positive/30
border-amber-200|border-signal-warning/20
border-amber-300|border-signal-warning/30
border-red-200|border-signal-critical/20
border-red-300|border-signal-critical/30
border-rose-200|border-signal-critical/20
EOF
)

# Use awk to format sed -i expressions, with word boundaries that work both
# inside `className="…"` and template literals.
SED_SCRIPT=$(awk -F'|' '
{
  # \b in BSD sed is unreliable — use look-arounds via character class.
  # Boundaries: double-quote, single-quote, backtick, space.
  printf "s#([\"'\''\\` ])%s([\"'\''\\` ])#\\1%s\\2#g\n", $1, $2
}' <<<"$MAP")

# BSD sed needs -E (extended regex) and inline -i syntax differs from GNU.
if sed --version >/dev/null 2>&1; then
  SED_INPLACE=(-E -i)
else
  SED_INPLACE=(-E -i '')
fi

total=0
files_changed=0
for root in "${TARGETS[@]}"; do
  while IFS= read -r -d '' f; do
    before=$(md5 -q "$f" 2>/dev/null || md5sum "$f" | awk '{print $1}')
    sed "${SED_INPLACE[@]}" -e "$SED_SCRIPT" "$f"
    after=$(md5 -q "$f" 2>/dev/null || md5sum "$f" | awk '{print $1}')
    if [[ "$before" != "$after" ]]; then
      files_changed=$((files_changed + 1))
      # Count replacements as the number of new tokens introduced
      n=$(grep -coE '(bg-paper|bg-paper-2|border-divider|bg-divider|text-ink|text-ink-2|text-ink-3|bg-signal-(positive|warning|critical)/10|text-signal-(positive|warning|critical))' "$f" || true)
      total=$((total + n))
      printf "  %-90s  tokens now: %d\n" "${f#$ROOT/}" "$n"
    fi
  done < <(find "$root" -type f \( -name '*.tsx' -o -name '*.ts' \) -print0)
done

printf "\nSweep complete: %d files changed, %d token sites.\n" "$files_changed" "$total"
