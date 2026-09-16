import Link from 'next/link';
import {
  ArrowRight,
  Shield,
  KeyRound,
  History,
  RotateCcw,
  Sparkles,
  Zap,
  Bot,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { HairlineRule } from '@/components/ui/HairlineRule';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import {
  getSEOTags,
  buildBreadcrumbSchema,
  absoluteUrl,
} from '@/libs/seo';
import ConnectorTabs from './_components/ConnectorTabs';
import ToolCatalogueTable from './_components/ToolCatalogueTable';
import ChatMock from './_components/ChatMock';
import { CATALOGUE } from './_components/catalogue';

export const metadata = getSEOTags({
  title: 'MCP Server for NuraVolt — Your plant data, wherever your AI lives',
  description:
    'Query NuraVolt from Claude Desktop, ChatGPT, Cursor, or any MCP-aware AI. Same tools your operators use in-app — now available inside whatever assistant your team already uses. 12 tools, scoped keys, full audit log.',
  canonicalUrlRelative: '/mcp',
  keywords: [
    'MCP server',
    'Model Context Protocol',
    'Claude Desktop solar',
    'ChatGPT solar operations',
    'AI solar analytics',
    'PV BESS AI',
    'NuraVolt MCP',
  ],
});

const softwareSchema = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'NuraVolt MCP Server',
  applicationCategory: 'BusinessApplication',
  applicationSubCategory: 'Model Context Protocol Server',
  description:
    'MCP server exposing NuraVolt solar PV and BESS analytics to AI assistants including Claude Desktop, ChatGPT, and Cursor.',
  url: absoluteUrl('/mcp'),
  operatingSystem: 'Any',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  featureList: CATALOGUE.map((t) => t.name),
};

const breadcrumb = buildBreadcrumbSchema([
  { name: 'Home', urlRelative: '/' },
  { name: 'Platform', urlRelative: '/platform/features' },
  { name: 'MCP Server', urlRelative: '/mcp' },
]);

export default function MCPLandingPage() {
  return (
    <>
      <SchemaJsonLd data={[softwareSchema, breadcrumb]} />

      {/* ─────────────────────────── Hero */}
      <MarketingSection size="hero" as="div">
        <div className="max-w-4xl">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            MCP Server · New
          </div>
          <h1 className="text-h1 sm:text-display font-semibold text-ink mb-6">
            Your plant data, wherever your AI lives.
          </h1>
          <p className="text-body text-ink-2 mb-8 max-w-2xl">
            Talk to your NuraVolt plants from Claude Desktop, ChatGPT, Cursor, or any
            MCP-aware assistant. Same 12 tools your operators use inside the platform, now
            available inside whichever AI your team already opens every morning.
          </p>
          <div className="flex flex-col sm:flex-row flex-wrap gap-3">
            <Button size="lg" asChild>
              <Link href="/dashboard/settings/api-keys">
                Generate a key
                <ArrowRight className="w-4 h-4 ml-2" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="/mcp/setup">Read the setup guide</Link>
            </Button>
          </div>

          {/* Trust row */}
          <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 text-meta text-ink-3">
            <TrustPill icon={<KeyRound className="h-3.5 w-3.5" />} label="SHA-256 hashed keys" />
            <TrustPill icon={<Shield className="h-3.5 w-3.5" />} label="Scoped access" />
            <TrustPill icon={<History className="h-3.5 w-3.5" />} label="Full audit log" />
            <TrustPill icon={<RotateCcw className="h-3.5 w-3.5" />} label="Revocable in one click" />
          </div>
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* ─────────────────────────── Why it matters */}
      <MarketingSection size="default">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-14 items-center">
          <div>
            <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
              Why it matters
            </div>
            <h2 className="text-h1 font-semibold text-ink mb-4">
              From AI in your product to your product in AI.
            </h2>
            <p className="text-body text-ink-2 mb-4">
              Everyone builds AI <em>inside</em> their SaaS these days. That&apos;s useful,
              but it still means your ops lead has to log in, find the right screen, and
              ask a question in your chat window.
            </p>
            <p className="text-body text-ink-2 mb-4">
              MCP flips it. Your data becomes a tool source that any AI assistant can
              call. Your team asks the AI they already use, and the answer comes with real
              NuraVolt data, real timestamps, real citations — not a hallucinated
              paraphrase of a marketing page.
            </p>
            <p className="text-body text-ink-2">
              For asset managers running plants across a portfolio, that&apos;s the
              difference between another dashboard to remember and a colleague they can
              ping from anywhere.
            </p>
          </div>
          <div>
            <ChatMock />
          </div>
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* ─────────────────────────── How it works */}
      <MarketingSection size="default" surface="paper-2">
        <div className="max-w-3xl mb-10">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            How it works
          </div>
          <h2 className="text-h1 font-semibold text-ink mb-3">
            Three steps, ten minutes end-to-end.
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Step
            n="1"
            title="Generate a scoped key"
            body="In the dashboard, mint an API key. Pick the scopes it should have — read-only, or full agent with write access to tickets and cleaning schedules."
            icon={<KeyRound className="w-5 h-5" />}
          />
          <Step
            n="2"
            title="Paste into your assistant"
            body="Add a one-line MCP config to Claude Desktop, ChatGPT, Cursor, or Continue. Restart. NuraVolt shows up as a tool source."
            icon={<Bot className="w-5 h-5" />}
          />
          <Step
            n="3"
            title="Ask questions"
            body="The AI now knows how to fetch your plants, run diagnoses, search your knowledge base, and open tickets — all against real data, with a full audit trail."
            icon={<Sparkles className="w-5 h-5" />}
          />
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* ─────────────────────────── Tool catalogue */}
      <MarketingSection size="default">
        <div className="max-w-3xl mb-8">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            Tool catalogue
          </div>
          <h2 className="text-h1 font-semibold text-ink mb-3">
            12 tools across every asset lifecycle.
          </h2>
          <p className="text-body text-ink-2">
            The same tools Shams uses inside the platform. Scope-controlled so a
            single key can be read-only, agent-grade, or something in between.
          </p>
        </div>
        <ToolCatalogueTable />
      </MarketingSection>

      <HairlineRule />

      {/* ─────────────────────────── Connector setup */}
      <MarketingSection size="default" surface="paper-2">
        <div className="max-w-3xl mb-8">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            Connect it
          </div>
          <h2 className="text-h1 font-semibold text-ink mb-3">
            Copy, paste, done.
          </h2>
          <p className="text-body text-ink-2">
            One config block per host. HTTP streaming under the hood, so it works from any
            MCP-aware client that speaks the current spec.
          </p>
        </div>
        <ConnectorTabs />
      </MarketingSection>

      <HairlineRule />

      {/* ─────────────────────────── Security & governance */}
      <MarketingSection size="default">
        <div className="max-w-3xl mb-10">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            Security & governance
          </div>
          <h2 className="text-h1 font-semibold text-ink mb-3">
            Every call, logged. Every write, idempotent. Every key, revocable.
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SecurityCard
            icon={<KeyRound className="w-5 h-5 text-primary" />}
            title="Keys hashed at rest"
            body="Raw tokens are shown to you exactly once. Only a SHA-256 hash and a 14-character prefix live in the database, so a database leak can't produce a working credential."
          />
          <SecurityCard
            icon={<Shield className="w-5 h-5 text-primary" />}
            title="Fine-grained scopes"
            body="Ten scopes across read and write. A read-only key can't create tickets. A tickets-only key can't touch cleaning schedules. Every tool declares its required scope in-code."
          />
          <SecurityCard
            icon={<RotateCcw className="w-5 h-5 text-primary" />}
            title="Idempotent writes"
            body="Every write tool requires an idempotency key. Retries return the original result — a flaky network can never create the same ticket twice."
          />
          <SecurityCard
            icon={<History className="w-5 h-5 text-primary" />}
            title="Full audit log"
            body="Every call — read or write, success or forbidden — writes a row to McpToolCall with duration, args, status, and (for writes) the row it created. Visible in the dashboard in real time."
          />
        </div>
        <p className="text-meta text-ink-3 mt-6 max-w-3xl">
          On Enterprise, skip shared keys entirely: add NuraVolt as a connector by URL
          and each teammate signs in with their own account over OAuth. Access follows
          per-user plant permissions and the audit log names the person, not a key.
        </p>
      </MarketingSection>

      <HairlineRule />

      {/* ─────────────────────────── Use cases */}
      <MarketingSection size="default" surface="paper-2">
        <div className="max-w-3xl mb-10">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            What your team will actually ask
          </div>
          <h2 className="text-h1 font-semibold text-ink mb-3">
            Three real questions, three real answers.
          </h2>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <UseCase
            role="Ops lead · Claude Desktop"
            question="NuraVolt, which plants have the worst soiling forecast next 30 days? Draft me a cleaning schedule."
            tools={['nuravolt_list_plants', 'nuravolt_get_soiling_forecast', 'nuravolt_approve_cleaning_schedule']}
          />
          <UseCase
            role="Asset manager · ChatGPT"
            question="Show me open critical tickets across the fleet, ranked by revenue at risk."
            tools={['nuravolt_list_tickets']}
          />
          <UseCase
            role="Field engineer · Cursor"
            question="Diagnose INV-07-14 at Sapphire Ridge. What's the recommended action?"
            tools={['nuravolt_list_inverters', 'nuravolt_get_inverter_classification', 'nuravolt_diagnose_inverter']}
          />
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* ─────────────────────────── CTA */}
      <MarketingSection size="default">
        <div className="max-w-3xl">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            Ship it
          </div>
          <h2 className="text-h1 font-semibold text-ink mb-4">
            Ten minutes from now, your team is asking NuraVolt questions in Claude.
          </h2>
          <p className="text-body text-ink-2 mb-8 max-w-2xl">
            Mint a scoped key, paste the config, restart your AI. If you&apos;d rather
            walk through it with us first, book a demo.
          </p>
          <div className="flex flex-col sm:flex-row flex-wrap gap-3">
            <Button size="lg" asChild>
              <Link href="/dashboard/settings/api-keys">
                Generate a key
                <ArrowRight className="w-4 h-4 ml-2" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="/mcp/setup">Read the setup guide</Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <a href="mailto:hello@nuravolt.com?subject=NuraVolt%20MCP%20demo">
                Book a demo
              </a>
            </Button>
          </div>
        </div>
      </MarketingSection>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Local components (only used on this page)
// ─────────────────────────────────────────────────────────────────────────

function TrustPill({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-ink-2">
      {icon}
      {label}
    </span>
  );
}

function Step({
  n,
  title,
  body,
  icon,
}: {
  n: string;
  title: string;
  body: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="bg-paper border border-divider rounded p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="font-mono text-meta text-ink-3">{n}</div>
        <div className="text-primary">{icon}</div>
      </div>
      <h3 className="text-lg font-semibold text-ink mb-2">{title}</h3>
      <p className="text-body text-ink-2 text-sm leading-relaxed">{body}</p>
    </div>
  );
}

function SecurityCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="bg-paper border border-divider rounded p-6">
      <div className="flex items-center gap-2 mb-3">
        {icon}
        <h3 className="text-base font-semibold text-ink">{title}</h3>
      </div>
      <p className="text-body text-ink-2 text-sm leading-relaxed">{body}</p>
    </div>
  );
}

function UseCase({
  role,
  question,
  tools,
}: {
  role: string;
  question: string;
  tools: string[];
}) {
  return (
    <div className="bg-paper border border-divider rounded p-5 flex flex-col h-full">
      <div className="font-mono text-meta uppercase tracking-[0.06em] text-ink-3 mb-3">
        {role}
      </div>
      <p className="text-body text-ink font-medium mb-4">&ldquo;{question}&rdquo;</p>
      <div className="mt-auto flex flex-wrap gap-1.5">
        {tools.map((t) => (
          <span
            key={t}
            className="rounded bg-paper-2 border border-divider px-1.5 py-0.5 font-mono text-[10px] text-ink-2"
          >
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}
