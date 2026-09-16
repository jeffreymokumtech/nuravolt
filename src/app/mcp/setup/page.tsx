import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { HairlineRule } from '@/components/ui/HairlineRule';
import { Button } from '@/components/ui/button';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import {
  SectionHeading,
  Prereq,
  Numbered,
  Trouble,
} from '@/components/content/TutorialPrimitives';
import {
  getSEOTags,
  buildBreadcrumbSchema,
  buildArticleSchema,
} from '@/libs/seo';
import ConnectorTabs from '../_components/ConnectorTabs';
import { CATALOGUE, SCOPE_DESCRIPTIONS } from '../_components/catalogue';
import { ALL_SCOPES, type Scope } from '@/lib/mcp/scopes';
import { MCP_ENDPOINT } from '../_components/snippets';

export const metadata = getSEOTags({
  title: 'MCP Setup Guide — NuraVolt',
  description:
    'Step-by-step setup for the NuraVolt MCP server: generate a scoped API key, install the connector in Claude Desktop, ChatGPT, or Cursor, verify with a real tool call. Scope reference, rate limits, and troubleshooting.',
  canonicalUrlRelative: '/mcp/setup',
  keywords: [
    'MCP setup',
    'NuraVolt setup',
    'Claude Desktop MCP',
    'ChatGPT custom connector',
    'Cursor MCP',
    'Model Context Protocol setup',
  ],
});

const article = buildArticleSchema({
  title: 'NuraVolt MCP Setup Guide',
  description:
    'How to connect Claude Desktop, ChatGPT, or Cursor to NuraVolt over the Model Context Protocol.',
  urlRelative: '/mcp/setup',
});
const breadcrumb = buildBreadcrumbSchema([
  { name: 'Home', urlRelative: '/' },
  { name: 'MCP Server', urlRelative: '/mcp' },
  { name: 'Setup', urlRelative: '/mcp/setup' },
]);

export default function MCPSetupPage() {
  return (
    <>
      <SchemaJsonLd data={[article, breadcrumb]} />

      {/* ─────────────────────────── Hero */}
      <MarketingSection size="hero" as="div">
        <div className="max-w-3xl">
          <Link
            href="/mcp"
            className="inline-flex items-center gap-1.5 text-meta text-ink-3 hover:text-primary mb-6"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to overview
          </Link>
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            Setup guide
          </div>
          <h1 className="text-h1 sm:text-display font-semibold text-ink mb-6">
            Connect NuraVolt to Claude, ChatGPT, or Cursor.
          </h1>
          <p className="text-body text-ink-2 max-w-2xl">
            Three real steps. If everything is in place, ten minutes end-to-end. This page
            is also the technical reference — scopes, rate limits, idempotency, troubleshooting.
          </p>
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* ─────────────────────────── Prerequisites */}
      <MarketingSection size="default">
        <SectionHeading eyebrow="Before you start" title="Prerequisites" />
        <ul className="space-y-3 text-body text-ink-2">
          <Prereq label="A NuraVolt organisation." body="If you haven't signed up yet, book a demo — we onboard your plants first." />
          <Prereq
            label="Admin role in the org."
            body="Only admins can mint MCP API keys. Contact your NuraVolt admin if you don't have this."
          />
          <Prereq
            label="An MCP-aware client."
            body="Claude Desktop (Nov 2025 or later), ChatGPT Business / Enterprise, Cursor, or Continue.dev. Anything speaking the current MCP HTTP-streaming spec works."
          />
        </ul>
      </MarketingSection>

      <HairlineRule />

      {/* ─────────────────────────── Step 1 */}
      <MarketingSection size="default" surface="paper-2">
        <SectionHeading eyebrow="Step 1" title="Generate a scoped key" />
        <ol className="space-y-3 text-body text-ink-2 max-w-2xl mb-6">
          <Numbered n={1}>
            Open{' '}
            <Link
              href="/dashboard/settings/api-keys"
              className="text-primary underline underline-offset-2 hover:no-underline"
            >
              Settings › MCP API keys
            </Link>{' '}
            in the dashboard.
          </Numbered>
          <Numbered n={2}>Click <strong>Generate key</strong>.</Numbered>
          <Numbered n={3}>
            Give the key a name that identifies the human or app using it (e.g. <em>Claude
            Desktop — Anna</em>). This name only shows in your dashboard.
          </Numbered>
          <Numbered n={4}>
            Pick scopes. Start with <strong>Read-only preset</strong> for a first
            connection, upgrade to <strong>Full agent preset</strong> when you&apos;re
            ready to let the AI create tickets and cleaning schedules.
          </Numbered>
          <Numbered n={5}>
            Copy the raw token — <span className="font-mono">nv_live_&hellip;</span> — the
            reveal dialog shows once and never again.
          </Numbered>
        </ol>
        <div className="rounded border border-divider bg-paper p-4 max-w-2xl text-meta text-ink-3">
          <strong className="text-ink">Keep it safe.</strong> We store only the SHA-256
          hash. If you lose the token, revoke the key and generate a new one — we
          can&apos;t recover it for you.
        </div>
        <div className="rounded border border-divider bg-paper p-4 max-w-2xl text-meta text-ink-3 mt-3">
          <strong className="text-ink">On Enterprise?</strong> Skip the key entirely.
          Add NuraVolt as a connector by URL and your client walks each user through
          OAuth sign-in with their own NuraVolt account. Access follows per-user plant
          permissions and every tool call is attributed to the person who authorized it.
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* ─────────────────────────── Step 2 */}
      <MarketingSection size="default">
        <SectionHeading eyebrow="Step 2" title="Install the connector" />
        <ConnectorTabs />
      </MarketingSection>

      <HairlineRule />

      {/* ─────────────────────────── Step 3 */}
      <MarketingSection size="default" surface="paper-2">
        <SectionHeading eyebrow="Step 3" title="Verify it works" />
        <p className="text-body text-ink-2 mb-4 max-w-2xl">
          Restart your client. In a new conversation, ask it:
        </p>
        <blockquote className="border-l-2 border-primary bg-paper rounded-r px-4 py-3 text-body text-ink italic max-w-2xl mb-6">
          &ldquo;Using the NuraVolt connector, list my plants.&rdquo;
        </blockquote>
        <p className="text-body text-ink-2 mb-3 max-w-2xl">
          The assistant should call <code className="font-mono text-ink">nuravolt_list_plants</code>{' '}
          and return your real plants. If it does, connectivity + auth + scopes are all good.
        </p>
        <p className="text-body text-ink-2 max-w-2xl">
          You can also confirm in the dashboard — the call should show up in the{' '}
          <Link href="/dashboard/settings/api-keys" className="text-primary underline underline-offset-2">
            Recent tool calls
          </Link>{' '}
          audit panel within seconds.
        </p>
      </MarketingSection>

      <HairlineRule />

      {/* ─────────────────────────── Scope reference */}
      <MarketingSection size="default" id="scopes">
        <SectionHeading eyebrow="Reference" title="Scopes" />
        <p className="text-body text-ink-2 mb-6 max-w-2xl">
          Ten fine-grained scopes. Every tool declares exactly which scope it needs; a
          key without that scope gets a <code className="font-mono text-ink">forbidden</code>{' '}
          error with the specific missing scope named.
        </p>
        <div className="border border-divider rounded overflow-hidden bg-paper">
          <table className="w-full text-sm">
            <thead className="bg-paper-2 text-left">
              <tr className="font-mono text-meta uppercase tracking-[0.06em] text-ink-3">
                <th className="px-4 py-3">Scope</th>
                <th className="px-4 py-3">What it grants</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {ALL_SCOPES.map((s: Scope) => (
                <tr key={s}>
                  <td className="px-4 py-3 font-mono text-[13px] text-ink whitespace-nowrap">
                    {s}
                  </td>
                  <td className="px-4 py-3 text-body text-ink-2">{SCOPE_DESCRIPTIONS[s]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* ─────────────────────────── Tool reference */}
      <MarketingSection size="default" surface="paper-2" id="tools">
        <SectionHeading eyebrow="Reference" title="Tools" />
        <p className="text-body text-ink-2 mb-6 max-w-2xl">
          Every tool the MCP server exposes. All schemas are Zod-validated on the server —
          malformed args get rejected with a structured error.
        </p>
        <div className="border border-divider rounded overflow-hidden bg-paper">
          <table className="w-full text-sm">
            <thead className="bg-paper-2 text-left">
              <tr className="font-mono text-meta uppercase tracking-[0.06em] text-ink-3">
                <th className="px-4 py-3">Tool</th>
                <th className="px-4 py-3">Purpose</th>
                <th className="px-4 py-3">Scope</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {CATALOGUE.map((t) => (
                <tr key={t.name}>
                  <td className="px-4 py-3 font-mono text-[13px] text-ink whitespace-nowrap">
                    {t.name}
                    {t.kind === 'write' && (
                      <span className="ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-primary/10 text-primary">
                        write
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-body text-ink-2">{t.purpose}</td>
                  <td className="px-4 py-3 font-mono text-[11px] text-ink-2 whitespace-nowrap">
                    {t.scope}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* ─────────────────────────── Rate limits + idempotency + audit */}
      <MarketingSection size="default" id="operations">
        <SectionHeading eyebrow="Operations" title="Rate limits, idempotency, audit" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <OpsCard title="Rate limits">
            <p className="text-body text-ink-2 text-sm leading-relaxed">
              60 requests per minute and 5,000 per day per key, per plan tier. Bursts over
              the limit return a structured{' '}
              <code className="font-mono text-ink">rate_limited</code> error with{' '}
              <code className="font-mono text-ink">retry_after_sec</code>. Well-behaved
              clients back off automatically.
            </p>
          </OpsCard>
          <OpsCard title="Idempotency">
            <p className="text-body text-ink-2 text-sm leading-relaxed">
              Every write tool takes an{' '}
              <code className="font-mono text-ink">idempotency_key</code>. Retries with
              the same key + tool return the original result, no duplicate row. Use a
              stable key per logical action (e.g. a UUID your agent generates once per
              user intent).
            </p>
          </OpsCard>
          <OpsCard title="Audit">
            <p className="text-body text-ink-2 text-sm leading-relaxed">
              Every call — read, write, forbidden, rate-limited — writes an audit row
              with duration, args, status, and (for writes) the row it created. Visible in
              the dashboard&apos;s <em>Recent tool calls</em> panel and queryable via the
              admin API.
            </p>
          </OpsCard>
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* ─────────────────────────── Troubleshooting */}
      <MarketingSection size="default" surface="paper-2" id="troubleshooting">
        <SectionHeading eyebrow="If something breaks" title="Troubleshooting" />
        <div className="space-y-4 max-w-3xl">
          <Trouble
            symptom="HTTP 401 on every call"
            fix="Bearer token is missing, malformed, or the key has been revoked. Copy the token again from the reveal dialog if you still have it; otherwise revoke and regenerate."
          />
          <Trouble
            symptom={"forbidden: Missing required scope: <scope>"}
            fix="The key doesn't grant that scope. In Settings → MCP API keys, revoke the current key and generate a new one with the required scope ticked."
          />
          <Trouble
            symptom={"rate_limited: minute_limit"}
            fix="Your client is bursting. Wait retry_after_sec seconds, then retry. If you need higher throughput sustainably, talk to us about plan tiers."
          />
          <Trouble
            symptom={"invalid_transition: NEW → DONE"}
            fix="Tickets must move through the workflow — you can only jump from NEW to VALIDATED or WONT_FIX. Read the allowed-transitions map in the tool schema."
          />
          <Trouble
            symptom="Tool doesn't appear in the assistant"
            fix="Restart the client fully. In Claude Desktop, use ⌘Q to quit, not just close the window. In Cursor, toggle NuraVolt off and on in Settings → MCP."
          />
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* ─────────────────────────── CTA */}
      <MarketingSection size="default">
        <div className="max-w-3xl">
          <h2 className="text-h1 font-semibold text-ink mb-4">
            Ready when you are.
          </h2>
          <div className="flex flex-col sm:flex-row flex-wrap gap-3">
            <Button size="lg" asChild>
              <Link href="/dashboard/settings/api-keys">Generate a key</Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="/mcp">Back to overview</Link>
            </Button>
          </div>
          <p className="text-meta text-ink-3 mt-6">
            MCP endpoint: <code className="font-mono text-ink">{MCP_ENDPOINT}</code>
          </p>
        </div>
      </MarketingSection>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// SectionHeading / Prereq / Numbered / Trouble live in
// @/components/content/TutorialPrimitives so docs tutorials share them.

function OpsCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-paper border border-divider rounded p-5">
      <h3 className="text-base font-semibold text-ink mb-2">{title}</h3>
      {children}
    </div>
  );
}
