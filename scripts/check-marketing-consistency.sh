#!/usr/bin/env bash
# scripts/check-marketing-consistency.sh
#
# Fails non-zero if any banned styling pattern appears on the marketing surface.
# Banned patterns come from the redesign plan — once a file is migrated to the
# new design tokens, it must never reintroduce them.
#
# Scope = the marketing surface only. Internal product surfaces (/dashboard,
# /chat, /showcase, /demo, /api), error pages, and the soiling dashboard
# components are explicitly excluded — they have their own conventions.
#
# Add files to SCOPED_PATHS as they are migrated. The whole marketing surface
# should be in scope by the end of the redesign rollout.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Pages and components that have been migrated to the new design tokens.
# Anything listed here is checked against the banned patterns below.
# Expand this list as the migration progresses.
SCOPED_PATHS=(
  "src/components/ui/HairlineRule.tsx"
  "src/components/ui/MarketingSection.tsx"
  "src/components/ui/Sparkline.tsx"
  "src/components/ui/KPIReadout.tsx"
  "src/components/ui/DataPanel.tsx"
  "src/components/ui/button.tsx"
  "src/app/internal/style-guide/page.tsx"
  "src/components/layouts/MarketingHeader.tsx"
  "src/components/Footer.tsx"
  "src/components/landing/HeroSection.tsx"
  "src/components/landing/ProofStripSection.tsx"
  "src/components/landing/TrustBar.tsx"
  "src/components/landing/ProblemSection.tsx"
  "src/components/landing/ConsultingServicesSection.tsx"
  "src/components/landing/AuditLeadForm.tsx"
  "src/components/landing/LatestBlogPosts.tsx"
  "src/components/landing/NewFAQSection.tsx"
  "src/components/resources/ResourceCTA.tsx"
  "src/components/landing/LiveShowcaseTickerStrip.tsx"
  "src/components/landing/MethodologyStripSection.tsx"
  "src/app/page.tsx"
  "src/app/about/page.tsx"
  "src/app/engagements/page.tsx"
  "src/app/case-studies/page.tsx"
  "src/components/layouts/PublicLayout.tsx"
  "src/app/solutions/pv-monitoring/page.tsx"
  "src/app/solutions/bess-monitoring/page.tsx"
  "src/app/solutions/wind-monitoring/page.tsx"
  "src/app/solutions/layout.tsx"
  "src/app/blog/page.tsx"
  "src/app/blog/layout.tsx"
  "src/app/blog/[articleId]/page.tsx"
  "src/app/blog/bess-faults-ml-adds-value/page.tsx"
  "src/app/blog/cost-of-poor-irradiation-data/page.tsx"
  "src/app/resources/page.tsx"
  "src/app/resources/[slug]/page.tsx"
  "src/app/roi-calculator/page.tsx"
  "src/app/platform/layout.tsx"
  "src/app/platform/features/page.tsx"
  "src/app/platform/integrations/page.tsx"
  "src/app/platform/reporting/page.tsx"
  "src/app/audit-requested/page.tsx"
  "src/app/audit-requested/layout.tsx"
  "src/app/one-pager/page.tsx"
  "src/app/one-pager/layout.tsx"
  "src/app/brochure/page.tsx"
  "src/app/brochure/layout.tsx"
  "src/app/compliance/reference/page.tsx"
  "src/app/privacy/page.tsx"
  "src/app/terms/page.tsx"
  "src/app/privacy-policy/page.tsx"
  "src/app/tos/page.tsx"
  "src/components/landing/HowItWorksSection.tsx"
  "src/components/landing/IntegrationsLogoGrid.tsx"
  "src/components/landing/ROISection.tsx"
  "src/components/landing/SolutionSection.tsx"
  "src/components/landing/TransformationSection.tsx"
  "src/components/landing/BatteryAnalyticsSection.tsx"
  "src/components/landing/AboutNuraVoltSection.tsx"
  "src/components/resources/WhitepaperCard.tsx"
  "src/components/roi/ROIAssumptionsPanel.tsx"
  "src/components/roi/ROICalculatorAdvanced.tsx"
  "src/components/roi/ROICalculatorSimple.tsx"
  "src/components/roi/ROIResultsDashboard.tsx"
  "src/components/shared/EmailGate.tsx"
  "src/app/error.tsx"
  "src/app/not-found.tsx"
  "src/app/global-error.tsx"
  "src/components/BlogCard.tsx"
  "src/components/BlogMoreArticles.tsx"
  "src/components/BlogSpotlight.tsx"
)

# Banned patterns as "label|extended-regex" pairs.
# Each pattern is grepped (-E, extended regex) against every scoped path.
BANNED=(
  "Hardcoded Tailwind blue palette|(bg|text|border|ring|from|via|to)-blue-(50|100|200|300|400|500|600|700|800|900)"
  "Hardcoded Tailwind gray palette|(bg|text|border|ring|from|via|to)-gray-[0-9]+"
  "Hardcoded Tailwind slate palette|(bg|text|border|ring|from|via|to)-slate-[0-9]+"
  "Off-system border radius|rounded-(xl|2xl|3xl)"
  "Off-system shadow|shadow-(lg|xl|2xl)"
  "Gradient section band|bg-gradient-to-"
  "Daisyui card class|className=\"[^\"]*\\bcard\\b"
  "Daisyui btn class|className=\"[^\"]*\\bbtn\\b"
  "Daisyui badge class|className=\"[^\"]*\\bbadge\\b"
)

failed=0
total_files=${#SCOPED_PATHS[@]}

echo "Checking $total_files marketing-surface file(s) for banned patterns..."
echo ""

for path in "${SCOPED_PATHS[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "  ⚠️  Scoped path does not exist: $path (skipping)"
    continue
  fi

  for entry in "${BANNED[@]}"; do
    label="${entry%%|*}"
    pattern="${entry#*|}"
    if matches=$(grep -nE "$pattern" "$path" 2>/dev/null); then
      while IFS= read -r line; do
        echo "  ❌ $path: $label"
        echo "     $line"
        failed=$((failed + 1))
      done <<< "$matches"
    fi
  done
done

echo ""
if [[ $failed -gt 0 ]]; then
  echo "Marketing consistency check FAILED: $failed violation(s)."
  exit 1
fi

echo "Marketing consistency check passed."
exit 0
