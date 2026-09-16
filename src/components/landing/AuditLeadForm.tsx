'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ArrowRight, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { LEAD_INTENT_EVENT } from './leadFormIntent';

type CapacityBand = '<10' | '10-50' | '50-200' | '200+';

type Region =
  | 'Netherlands'
  | 'Germany'
  | 'Spain'
  | 'Italy'
  | 'United Kingdom'
  | 'GCC / Middle East'
  | 'Sub-Saharan Africa'
  | 'Other Europe'
  | 'Other';

export type LeadIntent = 'monitoring' | 'audit' | 'foundation';

interface FormState {
  email: string;
  name: string;
  capacity: CapacityBand | '';
  region: Region | '';
  pain: string;
  honeypot: string;
}

const CAPACITY_OPTIONS: { value: CapacityBand; label: string }[] = [
  { value: '<10', label: 'Under 10 MW' },
  { value: '10-50', label: '10, 50 MW' },
  { value: '50-200', label: '50, 200 MW' },
  { value: '200+', label: 'Over 200 MW (portfolio)' },
];

const REGION_OPTIONS: Region[] = [
  'Netherlands',
  'Germany',
  'Spain',
  'Italy',
  'United Kingdom',
  'GCC / Middle East',
  'Sub-Saharan Africa',
  'Other Europe',
  'Other',
];

const INTENT_OPTIONS: { value: LeadIntent; label: string }[] = [
  { value: 'monitoring', label: 'Continuous monitoring' },
  { value: 'audit', label: 'One-off audit' },
  { value: 'foundation', label: 'Data Foundation' },
];

const INTENT_COPY: Record<LeadIntent, {
  eyebrow: string;
  heading: string;
  body: string;
  painLabel: string;
  painPlaceholder: string;
  submitLabel: string;
  trustBullets: string[];
}> = {
  monitoring: {
    eyebrow: 'Continuous monitoring · Sized to your portfolio',
    heading: 'Start continuous monitoring.',
    body: 'Tell us about your plant and we\'ll reply within 24 hours with a scoping call and a trial plan.',
    painLabel: 'What would you like to monitor most closely?',
    painPlaceholder: 'e.g. SoH trajectory and warranty cycles on a 100 MW BESS, soiling + inverter health across a 30 MW PV fleet',
    submitLabel: 'Request a monitoring scoping call',
    trustBullets: [
      '24-hour reply',
      'No annual lock-in',
      'Pricing scoped to your portfolio',
    ],
  },
  audit: {
    eyebrow: 'Fixed-scope · 2-3 weeks · From €1,000',
    heading: 'Find out what your data is hiding.',
    body: 'Tell us about your plant and we\'ll reply within 24 hours with a scoping doc and three call times.',
    painLabel: 'What would you like the audit to surface?',
    painPlaceholder: 'e.g. unexplained 4% PR drop since Q2, suspected soiling losses on the east-facing strings, BESS round-trip efficiency dropping',
    submitLabel: 'Request audit scoping',
    trustBullets: [
      '24-hour reply',
      'No commitment',
      'Audit fee credits back against platform',
    ],
  },
  foundation: {
    eyebrow: 'Data Foundation · Read-side · 2-3 weeks',
    heading: 'Set up your data foundation.',
    body: 'Tell us what you\'re running and we\'ll reply within 24 hours with an integration plan and a fixed quote.',
    painLabel: 'What does your current data setup look like?',
    painPlaceholder: 'e.g. 12 MW PV with Huawei inverters, no SCADA; or 3 MW BESS with Modbus TCP but no historian',
    submitLabel: 'Request Data Foundation scoping',
    trustBullets: [
      '24-hour reply',
      'Read-side ingestion, no hardware changes',
      'Fixed-quote integration',
    ],
  },
};

interface AuditLeadFormProps {
  variant?: 'standalone' | 'embedded';
  source?: string;
  defaultIntent?: LeadIntent;
  showIntentSelector?: boolean;
}

function readUtmParams(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'].forEach((key) => {
    const value = params.get(key);
    if (value) utm[key] = value;
  });
  return utm;
}

function readIntentFromUrl(): LeadIntent | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('intent');
  if (raw === 'monitoring' || raw === 'audit' || raw === 'foundation') return raw;
  return null;
}

const labelClass = 'text-meta font-mono uppercase tracking-[0.08em] text-ink-2';
const selectClass =
  'mt-2 flex h-10 w-full rounded-sm border border-divider bg-paper px-3 py-2 text-body text-ink focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-paper';

const AuditLeadForm = ({
  variant = 'standalone',
  source = 'homepage',
  defaultIntent = 'monitoring',
  showIntentSelector = true,
}: AuditLeadFormProps) => {
  const router = useRouter();
  const [intent, setIntent] = useState<LeadIntent>(defaultIntent);
  const [form, setForm] = useState<FormState>({
    email: '',
    name: '',
    capacity: '',
    region: '',
    pain: '',
    honeypot: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const utmRef = useRef<Record<string, string>>({});

  useEffect(() => {
    utmRef.current = readUtmParams();
    const urlIntent = readIntentFromUrl();
    if (urlIntent) setIntent(urlIntent);

    const handler = (e: Event) => {
      const detail = (e as CustomEvent<LeadIntent>).detail;
      if (detail === 'monitoring' || detail === 'audit' || detail === 'foundation') {
        setIntent(detail);
      }
    };
    window.addEventListener(LEAD_INTENT_EVENT, handler);
    return () => window.removeEventListener(LEAD_INTENT_EVENT, handler);
  }, []);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const copy = INTENT_COPY[intent];

  const isValid =
    form.email.trim().length > 3 &&
    /.+@.+\..+/.test(form.email) &&
    form.name.trim().length > 1 &&
    form.capacity !== '' &&
    form.region !== '';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/leads/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email.trim(),
          name: form.name.trim(),
          capacityBand: form.capacity,
          region: form.region,
          pain: form.pain.trim() || null,
          source: `${source}_${intent}`,
          intent,
          honeypot: form.honeypot,
          utmParams: utmRef.current,
        }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.error || 'Submission failed');
      }

      router.push(`/audit-requested?intent=${intent}`);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Something went wrong. Try again or email contact@nuravolt.com.',
      );
      setSubmitting(false);
    }
  };

  const containerClass =
    variant === 'embedded'
      ? 'w-full'
      : 'w-full max-w-2xl mx-auto bg-paper border border-divider rounded p-6 sm:p-8';

  return (
    <div id='audit-lead-form' className={containerClass}>
      {variant === 'standalone' && (
        <div className='mb-6'>
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
            {copy.eyebrow}
          </div>
          <h3 className='text-h2 font-semibold text-ink mb-2'>{copy.heading}</h3>
          <p className='text-body text-ink-2'>{copy.body}</p>
        </div>
      )}

      {showIntentSelector && (
        <div className='mb-6'>
          <div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-2'>
            What are you here for?
          </div>
          <div
            role='radiogroup'
            aria-label='Engagement type'
            className='inline-flex flex-wrap gap-1 p-1 rounded-sm border border-divider bg-paper'
          >
            {INTENT_OPTIONS.map((opt) => {
              const isActive = opt.value === intent;
              return (
                <button
                  key={opt.value}
                  type='button'
                  role='radio'
                  aria-checked={isActive}
                  onClick={() => setIntent(opt.value)}
                  className={`px-3 py-1.5 font-mono text-meta uppercase tracking-[0.08em] rounded-sm transition-colors ${
                    isActive ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className='space-y-5'>
        {/* Honeypot, hidden from real users */}
        <input
          type='text'
          name='company_website'
          autoComplete='off'
          tabIndex={-1}
          aria-hidden='true'
          value={form.honeypot}
          onChange={(e) => update('honeypot', e.target.value)}
          className='absolute left-[-9999px] w-px h-px opacity-0'
        />

        <div className='grid grid-cols-1 sm:grid-cols-2 gap-5'>
          <div>
            <Label htmlFor='audit-name' className={labelClass}>
              Full name <span className='text-signal-critical'>*</span>
            </Label>
            <Input
              id='audit-name'
              type='text'
              autoComplete='name'
              required
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              placeholder='Jane Operator'
              className='mt-2'
            />
          </div>
          <div>
            <Label htmlFor='audit-email' className={labelClass}>
              Work email <span className='text-signal-critical'>*</span>
            </Label>
            <Input
              id='audit-email'
              type='email'
              autoComplete='email'
              required
              value={form.email}
              onChange={(e) => update('email', e.target.value)}
              placeholder='jane@operator.com'
              className='mt-2'
            />
          </div>
        </div>

        <div className='grid grid-cols-1 sm:grid-cols-2 gap-5'>
          <div>
            <Label htmlFor='audit-capacity' className={labelClass}>
              Plant or portfolio size <span className='text-signal-critical'>*</span>
            </Label>
            <select
              id='audit-capacity'
              required
              value={form.capacity}
              onChange={(e) => update('capacity', e.target.value as CapacityBand)}
              className={selectClass}
            >
              <option value='' disabled>
                Select capacity
              </option>
              {CAPACITY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor='audit-region' className={labelClass}>
              Region <span className='text-signal-critical'>*</span>
            </Label>
            <select
              id='audit-region'
              required
              value={form.region}
              onChange={(e) => update('region', e.target.value as Region)}
              className={selectClass}
            >
              <option value='' disabled>
                Select region
              </option>
              {REGION_OPTIONS.map((region) => (
                <option key={region} value={region}>
                  {region}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <Label htmlFor='audit-pain' className={labelClass}>
            {copy.painLabel}{' '}
            <span className='text-ink-3 font-normal normal-case tracking-normal'>(optional)</span>
          </Label>
          <Textarea
            id='audit-pain'
            value={form.pain}
            onChange={(e) => update('pain', e.target.value)}
            placeholder={copy.painPlaceholder}
            rows={3}
            className='mt-2 resize-none'
            maxLength={500}
          />
          <p className='mt-1 text-meta text-ink-3'>Helps us tailor the scoping doc. Max 500 characters.</p>
        </div>

        {error && (
          <div className='rounded-sm border border-signal-critical/40 bg-signal-critical/5 px-4 py-3 text-sm text-signal-critical'>
            {error}
          </div>
        )}

        <div className='pt-2'>
          <Button type='submit' size='lg' disabled={!isValid || submitting} className='w-full sm:w-auto'>
            {submitting ? (
              <>
                <Loader2 className='w-4 h-4 mr-2 animate-spin' />
                Submitting…
              </>
            ) : (
              <>
                {copy.submitLabel}
                <ArrowRight className='w-4 h-4 ml-2' />
              </>
            )}
          </Button>
          <motion.div
            key={intent}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className='mt-4 flex flex-col sm:flex-row gap-3 sm:gap-6 font-mono text-meta uppercase tracking-[0.08em] text-ink-3'
          >
            {copy.trustBullets.map((bullet) => (
              <span key={bullet} className='inline-flex items-center gap-1.5'>
                <CheckCircle2 className='w-3.5 h-3.5 text-signal-positive' />
                {bullet}
              </span>
            ))}
          </motion.div>
        </div>
      </form>
    </div>
  );
};

export default AuditLeadForm;
