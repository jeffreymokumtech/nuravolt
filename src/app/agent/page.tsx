import Link from 'next/link';
import {
  ArrowRight,
  BatteryCharging,
  CheckCircle2,
  Droplets,
  Library,
  ListChecks,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { HairlineRule } from '@/components/ui/HairlineRule';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import { getSEOTags, buildBreadcrumbSchema, absoluteUrl } from '@/libs/seo';
import ChatMock from '@/app/mcp/_components/ChatMock';

export const metadata = getSEOTags({
  title: 'Shams, the AI agent for solar and storage operations | NuraVolt',
  description:
    'Shams is NuraVolt\'s AI agent. It works on your live SCADA, inverter, and battery data: explains faults, forecasts soiling, tracks battery health, and drafts the tickets and cleaning plans your team approves. Included with Business at a fixed monthly price.',
  canonicalUrlRelative: '/agent',
  keywords: [
    'AI agent solar',
    'solar operations agent',
    'AI solar O&M',
    'BESS AI agent',
    'solar copilot',
    'NuraVolt Shams',
  ],
});

const agentSchema = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Shams',
  applicationCategory: 'BusinessApplication',
  description:
    'AI agent for solar PV and BESS operations, working on live SCADA, inverter, and battery data inside the NuraVolt platform.',
  url: absoluteUrl('/agent'),
  operatingSystem: 'Any',
};

const breadcrumb = buildBreadcrumbSchema([
  { name: 'Home', urlRelative: '/' },
  { name: 'Shams', urlRelative: '/agent' },
]);

/**
 * Shams marketing page. Every capability listed here maps to a REAL agent
 * tool in src/lib/ai/chat-tools.ts / the MCP catalogue — keep the two in
 * sync and never list a capability the agent cannot actually perform.
 * Copy rules: sentence case, no em/en dashes, no emoji, no invented metrics.
 */

const CAPABILITIES = [
  {
    icon: Wrench,
    title: 'Explains faults in plain language',
    body: 'Deterministic fault classification with evidence, plus an AI deep dive over 30 days of digital twin data when you want the full story.',
  },
  {
    icon: Droplets,
    title: 'Forecasts soiling and cleaning',
    body: 'Per-inverter soiling ratio forecasts and cleaning windows, priced against what the dirt is costing you. It also checks the on-site irradiance sensor against a satellite reference and tells you when the sensor cannot be trusted.',
  },
  {
    icon: ListChecks,
    title: 'Drafts tickets, plans, and reports',
    body: 'Shams prepares the ticket, cleaning schedule, or recurring email report as an editable draft card. Your team reviews and confirms. Nothing ships without sign off.',
  },
  {
    icon: Library,
    title: 'Answers from your manuals',
    body: 'Upload OEM manuals and O&M runbooks; Shams cites the exact document and section it drew on, and says so when the docs do not cover it.',
  },
  {
    icon: BatteryCharging,
    title: 'Tracks battery revenue and health',
    body: 'Per-service revenue stacks for BESS assets, state of health trajectories, and warranty posture, on the same data the dashboard shows.',
  },
  {
    icon: Sparkles,
    title: 'Knows your fleet',
    body: 'Plants, inverters, open tickets, and the page you are looking at. Open Shams from any plant and it already has the context.',
  },
];

export default function AgentPage() {
  return (
    <>
      <SchemaJsonLd data={[agentSchema, breadcrumb]} />

      {/* Hero */}
      <MarketingSection size="hero" as="div">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          <div>
            <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
              Shams · NuraVolt&apos;s AI agent
            </div>
            <h1 className="text-h1 sm:text-display font-semibold text-ink mb-6 text-balance">
              The agent that runs solar and storage operations with your team.
            </h1>
            <p className="text-body text-ink-2 mb-4 max-w-xl">
              Shams is Arabic for sun. It is the AI agent inside NuraVolt: ask it anything
              about your fleet and it answers from your live SCADA, inverter, and battery
              data, then drafts the work your team approves.
            </p>
            <p className="text-body text-ink-2 mb-8 max-w-xl">
              One product, two modes. The dashboard for looking, Shams for asking, switched
              with one click and sharing the same plant context.
            </p>
            <div className="flex flex-col sm:flex-row flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link href="/pricing">
                  Included with Business
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href="/showcase/plant/helios">See the live showcase</Link>
              </Button>
            </div>
            <p className="mt-6 font-mono text-meta uppercase tracking-[0.08em] text-ink-3">
              Fixed monthly price. No per token billing.
            </p>
          </div>
          <ChatMock />
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* Capabilities — grounded in the real tool catalogue */}
      <MarketingSection size="default">
        <div className="max-w-2xl mb-10">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            What Shams can do
          </div>
          <h2 className="text-h1 font-semibold text-ink mb-4">
            Fifteen tools on your real plant data. Not a chat window bolted on.
          </h2>
          <p className="text-body text-ink-2">
            Every answer is grounded in a tool call against your plants. Shams never invents
            plant ids, inverter ids, or numbers, and it cites the timestamp of the data it used.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {CAPABILITIES.map((c) => (
            <div key={c.title} className="rounded-lg border border-divider bg-white p-6">
              <c.icon className="h-5 w-5 text-primary mb-3" aria-hidden />
              <h3 className="text-base font-semibold text-ink mb-2">{c.title}</h3>
              <p className="text-sm text-ink-2">{c.body}</p>
            </div>
          ))}
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* Safety model */}
      <MarketingSection size="default">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-start">
          <div>
            <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
              Built for critical infrastructure
            </div>
            <h2 className="text-h1 font-semibold text-ink mb-4">
              Draft and approve. Never autopilot on your assets.
            </h2>
            <p className="text-body text-ink-2 mb-4">
              Agents that act unsupervised on power plants are a liability, not a feature.
              Shams proposes; your operators decide.
            </p>
          </div>
          <ul className="space-y-4">
            {[
              'Tickets and cleaning schedules are drafts until a human clicks create.',
              'Shams only sees plants the signed-in user has access to, enforced per tool call on the server.',
              'Fair use limits are enforced as AI budgets per organization, so the fixed price stays fixed.',
              'Connect Shams\'s tools to Claude, ChatGPT, or Cursor via MCP with scoped, revocable keys and a full audit log.',
            ].map((line) => (
              <li key={line} className="flex gap-3 text-body text-ink-2">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-primary mt-0.5" aria-hidden />
                {line}
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <ShieldCheck className="h-4 w-4 text-ink-3" aria-hidden />
          <span className="text-meta text-ink-3">
            Want Shams inside your own AI assistant? See the
          </span>
          <Link href="/mcp" className="text-meta font-medium text-primary hover:underline">
            MCP server
          </Link>
        </div>
      </MarketingSection>

      <HairlineRule />

      {/* Pricing CTA */}
      <MarketingSection size="compact" surface="paper-2">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
          <div className="max-w-2xl">
            <h2 className="text-h1 font-semibold text-ink mb-3">
              Shams is included with Business.
            </h2>
            <p className="text-body text-ink-2">
              One fixed monthly price for the platform and the agent together, with fair use
              limits instead of per token billing. No usage meter anxiety.
            </p>
          </div>
          <div className="shrink-0">
            <Button size="lg" asChild>
              <Link href="/pricing">
                See pricing
                <ArrowRight className="w-4 h-4 ml-2" />
              </Link>
            </Button>
          </div>
        </div>
      </MarketingSection>
    </>
  );
}
