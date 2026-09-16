/**
 * Shared next-run computation for scheduled reports. Single source of truth
 * for POST /api/reports and the send-reports cron (they used to carry
 * disagreeing copies of this logic).
 *
 * The cron runs once daily at 07:00 UTC (vercel.json), so 07:00 UTC is the
 * only send time — day of week / day of month are the meaningful knobs.
 */

/** ISO day numbers, 1 = Monday .. 7 = Sunday. */
export function computeNextRunAt(
  schedule: 'weekly' | 'monthly',
  sendDayOfWeek?: number | null,
  sendDayOfMonth?: number | null,
  now: Date = new Date()
): Date {
  if (schedule === 'weekly') {
    const targetIso =
      sendDayOfWeek && sendDayOfWeek >= 1 && sendDayOfWeek <= 7 ? sendDayOfWeek : 1;
    // JS getUTCDay: 0=Sun..6=Sat → ISO 1=Mon..7=Sun
    const todayIso = now.getUTCDay() === 0 ? 7 : now.getUTCDay();
    let delta = (targetIso - todayIso + 7) % 7;
    // Same weekday: send next week (the cron has already passed 07:00 today
    // or will pick the row up within the hour either way; next week is the
    // unambiguous choice both callers can share).
    if (delta === 0) delta = 7;
    const next = new Date(now);
    next.setUTCDate(now.getUTCDate() + delta);
    next.setUTCHours(7, 0, 0, 0);
    return next;
  }

  // monthly
  const day =
    sendDayOfMonth && sendDayOfMonth >= 1 && sendDayOfMonth <= 28 ? sendDayOfMonth : 1;
  const thisMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, 7, 0, 0, 0)
  );
  if (thisMonth.getTime() > now.getTime()) return thisMonth;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, day, 7, 0, 0, 0));
}
