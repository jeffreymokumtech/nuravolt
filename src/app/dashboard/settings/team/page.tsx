'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Users,
  Plus,
  Trash2,
  X,
  AlertTriangle,
  Mail,
  Factory,
} from 'lucide-react';
import OpsOrgShell from '@/components/ops/OpsOrgShell';
import { authClient } from '@/lib/auth-client';

/**
 * Org team management: members (Better Auth) merged with the legacy
 * role/plant-access authz (see /api/team/members). Invites, role changes and
 * removals go through authClient.organization.* so seat limits and the
 * UserRole sync hooks apply automatically; per-plant access goes through
 * /api/team/members/[userId]/plant-access.
 */

interface PlantAccessRow {
  plant_id: string;
  plant_name: string | null;
  plant_slug: string | null;
  access_level: 'VIEW' | 'OPERATE' | 'MANAGE';
  expires_at: string | null;
}

interface MemberRow {
  memberId: string;
  userId: string;
  name: string | null;
  email: string | null;
  image: string | null;
  authRole: string;
  role: string;
  joinedAt: string;
  isSelf: boolean;
  plantAccess: PlantAccessRow[];
}

interface InvitationRow {
  id: string;
  email: string;
  role: string | null;
  expiresAt: string;
}

interface PlantRow {
  id: string;
  name: string;
  slug: string;
}

interface TeamResponse {
  members: MemberRow[];
  invitations: InvitationRow[];
  plants: PlantRow[];
  seats: { used: number; pending: number; cap: number | null };
  plan: string;
  canManage: boolean;
  canAssignPlantAccess: boolean;
}

/** Roles the UI can assign (Better Auth name → display label). */
const ASSIGNABLE_ROLES: Array<{ value: string; label: string; hint: string }> = [
  { value: 'admin', label: 'Manager', hint: 'Full access to all plants, can manage the team' },
  { value: 'member', label: 'Viewer', hint: 'Sees only plants granted below' },
];

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Manager',
  member: 'Viewer',
};

/** Legacy roles with org-wide plant access (no per-plant grants needed). */
const ORG_WIDE_LEGACY_ROLES = new Set(['SUPER_ADMIN', 'ORG_ADMIN', 'MANAGER']);

const ACCESS_LABELS: Record<string, string> = {
  VIEW: 'View',
  OPERATE: 'Operate',
  MANAGE: 'Manage',
};

export default function TeamPage() {
  const [team, setTeam] = useState<TeamResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);

  async function load() {
    setError(null);
    try {
      const res = await fetch('/api/team/members');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTeam(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load team');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const seats = team?.seats;
  const atCap = seats?.cap != null && seats.used + seats.pending >= seats.cap;
  const canManage = team?.canManage ?? false;

  return (
    <OpsOrgShell activeNavKey="team" section="TEAM">
    {/* .ops-legacy retones the page's SaaS-era gray/blue utility classes onto
        the ops token palette (both themes) without rewriting the internals. */}
    <div className="ops-legacy mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <Users className="h-6 w-6 text-blue-600" />
            Team
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            Invite teammates and set their org role. Viewers can be granted per-plant
            access below — a Viewer with Operate access on a plant is that plant&apos;s
            operator.
          </p>
          {seats && (
            <p className="mt-1 text-xs text-gray-500">
              Seats: {seats.used + seats.pending}
              {seats.cap != null ? ` / ${seats.cap}` : ' (unlimited)'}
              {seats.pending > 0 ? ` (${seats.pending} pending)` : ''}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <button
            type="button"
            onClick={() => setShowInvite(true)}
            disabled={!canManage || atCap}
            title={
              !canManage
                ? 'Only owners and managers can invite teammates.'
                : atCap
                  ? 'All seats on your plan are in use.'
                  : undefined
            }
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Invite teammate
          </button>
          {atCap && (
            <a href="/pricing" className="text-xs text-blue-600 hover:underline">
              Upgrade to add seats
            </a>
          )}
        </div>
      </header>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
        ) : !team || team.members.length === 0 ? (
          <div className="p-12 text-center">
            <Users className="mx-auto h-10 w-10 text-gray-300" />
            <p className="mt-3 text-sm text-gray-500">No members yet.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Member</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Plant access</th>
                <th className="px-4 py-2">Joined</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {team.members.map((member) => (
                <MemberTableRow
                  key={member.memberId}
                  member={member}
                  plants={team.plants}
                  canManage={canManage}
                  canAssignPlantAccess={team.canAssignPlantAccess}
                  onChanged={load}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {team && team.invitations.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
            <Mail className="h-4 w-4 text-gray-500" />
            Pending invitations
          </h2>
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-100">
                {team.invitations.map((inv) => (
                  <tr key={inv.id}>
                    <td className="px-4 py-3 text-gray-900">{inv.email}</td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {ROLE_LABELS[inv.role ?? 'member'] ?? inv.role}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      Expires {new Date(inv.expiresAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canManage && (
                        <span className="inline-flex items-center gap-1">
                          <ResendInviteButton invitation={inv} onDone={load} />
                          <button
                            type="button"
                            onClick={async () => {
                              await authClient.organization.cancelInvitation({ invitationId: inv.id });
                              load();
                            }}
                            className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                            title="Cancel invitation"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          onInvited={() => {
            setShowInvite(false);
            load();
          }}
        />
      )}
    </div>
    </OpsOrgShell>
  );
}

const ACCESS_OPTIONS = ['NONE', 'VIEW', 'OPERATE', 'MANAGE'] as const;

function MemberTableRow({
  member,
  plants,
  canManage,
  canAssignPlantAccess,
  onChanged,
}: {
  member: MemberRow;
  plants: PlantRow[];
  canManage: boolean;
  canAssignPlantAccess: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [editingAccess, setEditingAccess] = useState(false);
  const [accessBusy, setAccessBusy] = useState<string | null>(null);
  const isOwner = member.authRole === 'owner';
  const orgWide = ORG_WIDE_LEGACY_ROLES.has(member.role);
  const isOperator =
    !orgWide && member.plantAccess.some((a) => a.access_level === 'OPERATE' || a.access_level === 'MANAGE');

  async function setPlantAccess(plantId: string, level: string) {
    setAccessBusy(plantId);
    try {
      if (level === 'NONE') {
        const res = await fetch(
          `/api/team/members/${member.userId}/plant-access?plant_id=${encodeURIComponent(plantId)}`,
          { method: 'DELETE' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } else {
        const res = await fetch(`/api/team/members/${member.userId}/plant-access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plant_id: plantId, access_level: level }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      onChanged();
    } catch {
      alert('Failed to update plant access');
    } finally {
      setAccessBusy(null);
    }
  }

  async function updateRole(role: string) {
    setBusy(true);
    const { error } = await authClient.organization.updateMemberRole({
      memberId: member.memberId,
      role: role as any,
    });
    if (error) alert(error.message || 'Failed to update role');
    setBusy(false);
    onChanged();
  }

  async function remove() {
    if (!confirm(`Remove ${member.email ?? 'this member'} from the organization?`)) return;
    setBusy(true);
    const { error } = await authClient.organization.removeMember({
      memberIdOrEmail: member.memberId,
    });
    if (error) alert(error.message || 'Failed to remove member');
    setBusy(false);
    onChanged();
  }

  return (
    <>
      <tr className={busy ? 'opacity-50' : ''}>
        <td className="px-4 py-3">
          <div className="font-medium text-gray-900">
            {member.name ?? member.email ?? member.userId}
            {member.isSelf && <span className="ml-1.5 text-xs font-normal text-gray-400">(you)</span>}
          </div>
          {member.name && member.email && <div className="text-xs text-gray-500">{member.email}</div>}
        </td>
        <td className="px-4 py-3">
          {isOwner || !canManage || member.isSelf ? (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
              {ROLE_LABELS[member.authRole] ?? member.authRole}
            </span>
          ) : (
            <select
              value={member.authRole}
              onChange={(e) => updateRole(e.target.value)}
              disabled={busy}
              className="rounded-md border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
            >
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
        </td>
        <td className="px-4 py-3 text-xs">
          {orgWide ? (
            <span className="text-gray-500">All plants</span>
          ) : (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {isOperator && (
                <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                  Operator
                </span>
              )}
              <span className="text-gray-600">
                {member.plantAccess.length === 0
                  ? 'No plants'
                  : member.plantAccess.length <= 2
                    ? member.plantAccess
                        .map((a) => `${a.plant_name ?? a.plant_slug ?? 'plant'} · ${ACCESS_LABELS[a.access_level]}`)
                        .join(', ')
                    : `${member.plantAccess.length} plants`}
              </span>
              {canAssignPlantAccess && (
                <button
                  type="button"
                  onClick={() => setEditingAccess((v) => !v)}
                  className="text-blue-600 hover:underline"
                >
                  {editingAccess ? 'Done' : 'Edit'}
                </button>
              )}
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-xs text-gray-500">
          {new Date(member.joinedAt).toLocaleDateString()}
        </td>
        <td className="px-4 py-3 text-right">
          {canManage && !isOwner && !member.isSelf && (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
              title="Remove member"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </td>
      </tr>
      {editingAccess && !orgWide && (
        <tr>
          <td colSpan={5} className="bg-gray-50 px-4 py-3">
            <div className="space-y-1.5">
              <p className="text-xs text-gray-500">
                Per-plant access for {member.name ?? member.email}. Operate lets them run
                analyses and work tickets on that plant; Manage adds plant settings.
              </p>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {plants.map((plant) => {
                  const current =
                    member.plantAccess.find((a) => a.plant_id === plant.id)?.access_level ?? 'NONE';
                  return (
                    <label
                      key={plant.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs"
                    >
                      <span className="truncate font-medium text-gray-700">{plant.name}</span>
                      <select
                        value={current}
                        disabled={accessBusy === plant.id}
                        onChange={(e) => setPlantAccess(plant.id, e.target.value)}
                        className="rounded-md border border-gray-300 px-1.5 py-0.5 text-xs focus:border-blue-500 focus:outline-none disabled:opacity-50"
                      >
                        {ACCESS_OPTIONS.map((lvl) => (
                          <option key={lvl} value={lvl}>
                            {lvl === 'NONE' ? 'No access' : ACCESS_LABELS[lvl]}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
                {plants.length === 0 && (
                  <span className="text-xs text-gray-500">No plants in this organization yet.</span>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ResendInviteButton({
  invitation,
  onDone,
}: {
  invitation: InvitationRow;
  onDone: () => void;
}) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');

  async function resend() {
    setState('sending');
    // Better Auth's native resend: same email + role with resend:true refreshes
    // the pending invitation's expiry and re-sends the email.
    const { error } = await authClient.organization.inviteMember({
      email: invitation.email,
      role: (invitation.role ?? 'member') as any,
      resend: true,
    });
    if (error) {
      alert(error.message || 'Failed to resend the invitation.');
      setState('idle');
      return;
    }
    setState('sent');
    onDone();
  }

  return (
    <button
      type="button"
      onClick={resend}
      disabled={state !== 'idle'}
      className="rounded px-1.5 py-1 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-60"
      title="Send the invitation email again"
    >
      {state === 'sent' ? 'Sent' : state === 'sending' ? 'Sending…' : 'Resend'}
    </button>
  );
}

function InviteModal({ onClose, onInvited }: { onClose: () => void; onInvited: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes('@')) {
      setErr('Enter a valid email address.');
      return;
    }
    setSubmitting(true);
    const { error } = await authClient.organization.inviteMember({
      email: trimmed,
      role: role as any,
    });
    setSubmitting(false);
    if (error) {
      // Seat-limit errors carry the upgrade copy from beforeCreateInvitation.
      setErr(error.message || 'Failed to send the invitation.');
      return;
    }
    onInvited();
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <h2 className="text-base font-semibold text-gray-900">Invite a teammate</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 p-5">
          <div>
            <label className="block text-xs font-medium text-gray-700">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700">Role</label>
            <div className="mt-1 space-y-1.5">
              {ASSIGNABLE_ROLES.map((r) => (
                <label
                  key={r.value}
                  className={`flex cursor-pointer items-start gap-2 rounded-md border p-2.5 ${
                    role === r.value ? 'border-blue-500 bg-blue-50' : 'border-gray-200'
                  }`}
                >
                  <input
                    type="radio"
                    name="role"
                    checked={role === r.value}
                    onChange={() => setRole(r.value)}
                    className="mt-0.5 h-4 w-4 border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span>
                    <span className="block text-sm font-medium text-gray-900">{r.label}</span>
                    <span className="block text-xs text-gray-500">{r.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-500">
              Operators are Viewers granted Operate access on specific plants after they
              join — set it from the member&apos;s Plant access column.
            </p>
          </div>

          {err && (
            <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
              <AlertTriangle className="h-4 w-4" />
              {err}
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? 'Sending…' : 'Send invitation'}
          </button>
        </footer>
      </div>
    </div>
  );
}
