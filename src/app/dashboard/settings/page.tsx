import Link from 'next/link';
import { Users, Key, CreditCard, Database, Webhook, ChevronRight } from 'lucide-react';
import OpsOrgShell from '@/components/ops/OpsOrgShell';
import OrgProfileCard from '@/components/settings/OrgProfileCard';

/**
 * Settings index — links the org-level settings pages together
 * (they previously floated unlinked under /dashboard/settings/*).
 */

const SECTIONS = [
  {
    href: '/dashboard/settings/team',
    icon: Users,
    title: 'Team',
    description: 'Invite teammates, set roles, and control per-plant access.',
  },
  {
    href: '/dashboard/settings/api-keys',
    icon: Key,
    title: 'MCP API keys',
    description: 'Connect Claude, ChatGPT or Cursor to your NuraVolt data.',
  },
  {
    href: '/dashboard/settings/billing',
    icon: CreditCard,
    title: 'Billing',
    description: 'Your plan, usage limits, and invoices.',
  },
  {
    href: '/dashboard/settings/connections',
    icon: Database,
    title: 'Fleet connections',
    description: 'Every data connection across the portfolio, with polling health.',
  },
  {
    href: '/dashboard/settings/integrations',
    icon: Webhook,
    title: 'Integrations',
    description: 'Webhooks for ticket events, with signed deliveries.',
  },
];

export default function SettingsIndexPage() {
  return (
    <OpsOrgShell activeNavKey="org-settings" section="SETTINGS">
      <div className="ops-legacy mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="mt-1 text-sm text-gray-600">Organization-level settings.</p>
      </header>

      <OrgProfileCard />

      <div className="space-y-3">
        {SECTIONS.map(({ href, icon: Icon, title, description }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition hover:border-blue-300 hover:shadow"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50">
              <Icon className="h-5 w-5 text-blue-600" />
            </span>
            <span className="flex-1">
              <span className="block text-sm font-semibold text-gray-900">{title}</span>
              <span className="block text-xs text-gray-500">{description}</span>
            </span>
            <ChevronRight className="h-4 w-4 text-gray-400" />
          </Link>
        ))}
      </div>
      </div>
    </OpsOrgShell>
  );
}
