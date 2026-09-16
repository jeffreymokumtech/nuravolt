'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';

/**
 * In-app notification bell in the command bar. Shows recent active plant alerts
 * across the org (GET /api/notifications) with an unread dot; opening it marks
 * everything seen (localStorage last-seen timestamp). Read-only surface: acting
 * on an alert happens on the plant page. In unauthenticated contexts (public
 * demo) the fetch 401s and the bell simply shows nothing.
 */

interface NotifItem {
  id: string;
  plant_slug: string;
  plant_name: string;
  kind: string;
  severity: string;
  message: string;
  created_at: string;
  acknowledged_at: string | null;
}

const SEEN_KEY = 'nuravolt:notifSeen';

function relTime(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function NotificationBell() {
  const [items, setItems] = useState<NotifItem[]>([]);
  const [open, setOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState<number>(0);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications');
      if (!res.ok) {
        setItems([]);
        return;
      }
      const d = await res.json();
      setItems(Array.isArray(d.items) ? d.items : []);
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SEEN_KEY);
      if (raw) setLastSeen(Number(raw) || 0);
    } catch {
      /* ignore */
    }
    load();
    const t = setInterval(load, 90_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const unread = items.filter((i) => new Date(i.created_at).getTime() > lastSeen).length;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      const now = Date.now();
      setLastSeen(now);
      try {
        window.localStorage.setItem(SEEN_KEY, String(now));
      } catch {
        /* ignore */
      }
      load();
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggle}
        title="Notifications"
        aria-label="Notifications"
        className="relative inline-flex items-center transition-opacity hover:opacity-75"
        style={{ color: 'var(--ops-muted)' }}
      >
        <Bell size={15} aria-hidden />
        {unread > 0 && (
          <span
            className="absolute -right-1 -top-1 h-2 w-2 rounded-full ring-2"
            style={{ background: '#ef4444', ['--tw-ring-color' as string]: 'var(--ops-bg, #fff)' }}
          />
        )}
      </button>

      {open && (
        <div className="ops-light-scope absolute right-0 top-6 z-50 w-80 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
            <span className="text-xs font-semibold text-gray-900">Notifications</span>
            <span className="text-[11px] text-gray-400">{items.length} active</span>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-gray-400">No active alerts.</div>
            ) : (
              <ul className="divide-y divide-gray-50">
                {items.map((i) => (
                  <li key={i.id}>
                    <Link
                      href={`/dashboard/plant/${i.plant_slug}`}
                      onClick={() => setOpen(false)}
                      className="block px-3 py-2.5 hover:bg-gray-50"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: i.severity === 'CRITICAL' ? '#ef4444' : '#f59e0b' }}
                        />
                        <span className="truncate text-xs font-medium text-gray-900">
                          {i.plant_name}
                        </span>
                        <span className="ml-auto shrink-0 text-[10px] text-gray-400">
                          {relTime(i.created_at)}
                        </span>
                      </div>
                      <div className="mt-0.5 line-clamp-2 pl-3.5 text-[11px] leading-snug text-gray-600">
                        {i.message}
                      </div>
                      {i.acknowledged_at && (
                        <div className="pl-3.5 text-[10px] text-gray-400">acknowledged</div>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
