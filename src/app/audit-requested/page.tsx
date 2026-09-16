import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { CheckCircle2, ArrowRight, Calendar, FileText, MessagesSquare, Database, Activity, BarChart3 } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Request received | NuraVolt',
  description:
    'Your request has been received. We will reply within 24 hours with a scoping document and three suggested call times.',
  robots: { index: false, follow: true }
};

type Intent = 'monitoring' | 'audit' | 'foundation';

interface StepDef {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}

interface IntentCopy {
  eyebrow: string;
  heading: string;
  intro: string;
  steps: StepDef[];
  ctaBlockTitle: string;
  ctaBlockBody: string;
}

const COPY: Record<Intent, IntentCopy> = {
  monitoring: {
    eyebrow: 'Monitoring request received',
    heading: "Thanks, we'll be in touch within 24 hours.",
    intro:
      "A confirmation email is on its way. Here is how a typical continuous-monitoring onboarding runs so you know what you're signing up for.",
    steps: [
      {
        icon: Calendar,
        title: '30-minute scoping call',
        body: "We confirm portfolio scope, data access (SCADA / inverter API / CSV / BMS, whatever you have), reporting cadence, and pricing. No commitment. Subscription is invoiced only once scope is agreed in writing.",
      },
      {
        icon: Activity,
        title: 'Data integration · 2-3 weeks',
        body: 'Live ingestion set up against your inverters, SCADA, or BMS. Register mapping + unit validation + timezone reconciliation. Daily soiling, fault, SoH, and revenue tracking start running.',
      },
      {
        icon: BarChart3,
        title: 'Continuous operation',
        body: 'Daily dashboards, prioritised alerts with revenue impact, and ticketing. CSRD ESRS E1, EU AI Act, and EU Battery Regulation evidence baked in. Quarterly review call with your team.',
      },
    ],
    ctaBlockTitle: 'See it live before the call',
    ctaBlockBody:
      "Walk through the BESS and PV showcase plants, same dashboards your team will see, or read through anonymized case studies.",
  },
  audit: {
    eyebrow: 'Audit request received',
    heading: "Thanks, we'll be in touch within 24 hours.",
    intro:
      "A confirmation email is on its way. In the meantime, here is exactly what happens next so you know what you're signing up for.",
    steps: [
      {
        icon: Calendar,
        title: '30-minute scoping call',
        body: 'We confirm your audit goals, data access (SCADA / inverter API / CSV / InfluxDB, whatever you have), and timeline. No commitment. Audit fee is only invoiced once scope is agreed in writing.',
      },
      {
        icon: FileText,
        title: 'Two to three weeks of analysis',
        body: 'Week 1: data ingestion and sanity report. Week 2: anomaly sweep and loss disaggregation (soiling / fault / curtailment / availability) with €-impact per category. We surface 2-5% of recoverable annual revenue on a typical plant.',
      },
      {
        icon: MessagesSquare,
        title: '90-minute findings call + PDF report',
        body: 'A revenue-framed report you can take to your investment committee. Followed by a two-week Q&A window, bring follow-up questions as your team digests the findings.',
      },
    ],
    ctaBlockTitle: 'What credits back if you continue',
    ctaBlockBody:
      'The audit fee credits 100% against your first platform invoice if you sign a 12-month subscription within 60 days of report delivery. About half of our audit clients continue to the platform, the rest keep the report. Both paths are fine.',
  },
  foundation: {
    eyebrow: 'Data Foundation request received',
    heading: "Thanks, we'll be in touch within 24 hours.",
    intro:
      "A confirmation email is on its way. Here is how a typical Data Foundation engagement runs so you know what you're signing up for.",
    steps: [
      {
        icon: Calendar,
        title: '30-minute scoping call',
        body: 'We map out what you already have, inverters, BMS, meters, SCADA (if any), and any historical CSV/InfluxDB. Confirm protocols (Modbus TCP, OPC UA, MQTT, inverter cloud APIs), security boundary, and target output schema. Fixed quote follows within 48 hours.',
      },
      {
        icon: Database,
        title: 'Read-side integration · 2-3 weeks',
        body: 'We connect to your data sources, build register/tag maps, validate units and scaling, reconcile timezones, and stand up a normalized timeseries. Documented schema, API access, and read-only dashboards.',
      },
      {
        icon: FileText,
        title: 'Handover + ongoing access',
        body: "Documentation pack: integration map, data dictionary, quality monitoring rules. You own the data layer. Layer NuraVolt monitoring on top later if you'd like, it's your call.",
      },
    ],
    ctaBlockTitle: "What if you want analytics on top",
    ctaBlockBody:
      'Most Data Foundation clients use the layer standalone, for their own analytics, EMS integrations, or as a SCADA-grade telemetry stream. If you decide later you want NuraVolt monitoring (soiling, faults, SoH) on top, we can light that up against the same pipeline. No re-integration needed.',
  },
};

function resolveIntent(raw: string | string[] | undefined): Intent {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === 'monitoring' || v === 'foundation') return v;
  return 'audit';
}

interface PageProps {
  searchParams?: { intent?: string | string[] };
}

export default function AuditRequestedPage({ searchParams }: PageProps) {
  const intent = resolveIntent(searchParams?.intent);
  const copy = COPY[intent];

  return (
    <main className="min-h-screen bg-paper">
      <section className="container mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-24">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3 mb-6">
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-emerald-100 text-signal-positive">
              <CheckCircle2 className="w-7 h-7" />
            </div>
            <span className="font-mono text-meta uppercase tracking-[0.08em] text-signal-positive">
              {copy.eyebrow}
            </span>
          </div>

          <h1 className="text-h1 sm:text-display font-semibold text-ink mb-4 leading-tight">
            {copy.heading}
          </h1>
          <p className="text-body text-ink-2 mb-10">{copy.intro}</p>

          <div className="space-y-4 mb-12">
            {copy.steps.map((step, idx) => (
              <Step
                key={step.title}
                icon={step.icon}
                order={idx + 1}
                title={step.title}
                body={step.body}
              />
            ))}
          </div>

          <div className="rounded-sm bg-data-bg text-data-fg p-8 sm:p-10 border border-data-rule">
            <h2 className="text-h2 font-semibold mb-3 text-data-fg">{copy.ctaBlockTitle}</h2>
            <p className="text-data-fg-2 mb-6">{copy.ctaBlockBody}</p>
            <div className="flex flex-col sm:flex-row gap-3">
              <Button asChild size="lg" className="bg-paper text-ink hover:bg-paper-2">
                <Link href="/showcase">
                  See the live demo
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="border-data-rule text-data-fg hover:bg-data-bg-2">
                <Link href="/case-studies">View anonymized case studies</Link>
              </Button>
            </div>
          </div>

          <p className="mt-10 text-meta text-ink-3 text-center">
            Need to reach us before then? Reply to the confirmation email, it goes directly to
            Jeffrey.
          </p>
        </div>
      </section>
    </main>
  );
}

interface StepProps {
  icon: React.ComponentType<{ className?: string }>;
  order: number;
  title: string;
  body: string;
}

function Step({ icon: Icon, order, title, body }: StepProps) {
  return (
    <div className="flex gap-4 rounded-sm border border-divider bg-paper p-5 sm:p-6">
      <div className="flex-shrink-0">
        <div className="flex items-center justify-center w-11 h-11 rounded-sm bg-paper-2 text-primary">
          <Icon className="w-5 h-5" />
        </div>
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3">
            Step {order}
          </span>
          <h3 className="text-h2 font-semibold text-ink">{title}</h3>
        </div>
        <p className="text-body text-ink-2 leading-relaxed">{body}</p>
      </div>
    </div>
  );
}
