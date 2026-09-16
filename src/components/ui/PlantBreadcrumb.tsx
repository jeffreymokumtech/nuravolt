'use client';

import Link from 'next/link';
import { ChevronRight, Home } from 'lucide-react';
import { usePlantRoutePrefix, homeHrefFor } from '@/utils/routePrefix';

interface BreadcrumbSegment {
  label: string;
  href: string;
}

interface PlantBreadcrumbProps {
  plantId: string;
  plantName?: string;
  groupId?: string;
  groupName?: string;
  inverterId?: string;
  mpptId?: string;
  stringId?: string;
}

export default function PlantBreadcrumb({
  plantId,
  plantName,
  groupId,
  groupName,
  inverterId,
  mpptId,
  stringId,
}: PlantBreadcrumbProps) {
  // Prefix-aware so the trail keeps the user on the same surface
  // (/dashboard, /demo, or /showcase) instead of bouncing them to /demo.
  const prefix = usePlantRoutePrefix();

  const segments: BreadcrumbSegment[] = [
    {
      label: plantName || plantId,
      href: `${prefix}/plant/${plantId}`,
    },
  ];

  if (groupId) {
    segments.push({
      label: groupName || groupId,
      href: `${prefix}/plant/${plantId}/group/${encodeURIComponent(groupId)}`,
    });
  }

  if (inverterId) {
    segments.push({
      label: inverterId,
      href: `${prefix}/plant/${plantId}/inverter/${encodeURIComponent(inverterId)}`,
    });
  }

  if (mpptId) {
    segments.push({
      label: mpptId,
      href: `${prefix}/plant/${plantId}/inverter/${encodeURIComponent(inverterId || '')}/mppt/${encodeURIComponent(mpptId)}`,
    });
  }

  if (stringId) {
    segments.push({
      label: stringId,
      href: `${prefix}/plant/${plantId}/inverter/${encodeURIComponent(inverterId || '')}/string/${encodeURIComponent(stringId)}`,
    });
  }

  const lastIdx = segments.length - 1;
  const homeHref = homeHrefFor(prefix);

  return (
    <nav className="flex items-center gap-1.5 text-sm flex-wrap">
      <Link
        href={homeHref}
        className="text-gray-400 hover:text-blue-600 transition-colors"
        title="Portfolio"
      >
        <Home className="w-3.5 h-3.5" />
      </Link>
      {segments.map((seg, i) => (
        <span key={seg.href} className="flex items-center gap-1.5">
          <ChevronRight className="w-3.5 h-3.5 text-gray-300" />
          {i < lastIdx ? (
            <Link
              href={seg.href}
              className="text-gray-500 hover:text-blue-600 transition-colors"
            >
              {seg.label}
            </Link>
          ) : (
            <span className="font-medium text-gray-900">{seg.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
