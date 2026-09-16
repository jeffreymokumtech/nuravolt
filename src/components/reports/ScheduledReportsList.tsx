'use client';

import { useEffect, useState, useCallback } from 'react';
import { CalendarClock, Mail, Trash2, Send, Edit2 } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';

interface ScheduledReport {
  id: string;
  name: string;
  schedule: 'weekly' | 'monthly';
  next_run: string;
  recipient_emails: string[];
  [key: string]: any;
}

interface ScheduledReportsListProps {
  onEdit: (report: any) => void;
  onNewReport: () => void;
}

export default function ScheduledReportsList({ onEdit, onNewReport }: ScheduledReportsListProps) {
  const { t } = useLanguage();
  const [reports, setReports] = useState<ScheduledReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const fetchReports = useCallback(async () => {
    try {
      const res = await fetch('/api/reports');
      if (res.ok) {
        const data = await res.json();
        setReports(Array.isArray(data) ? data : data.data ?? data.reports ?? []);
      }
    } catch (err) {
      console.error('Failed to fetch reports:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const handleSendNow = async (id: string) => {
    setSendingId(id);
    try {
      const res = await fetch(`/api/reports/${id}/send`, { method: 'POST' });
      if (res.ok) {
        alert('Report sent successfully');
      } else {
        alert('Failed to send report');
      }
    } catch {
      alert('Failed to send report');
    } finally {
      setSendingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await fetch(`/api/reports/${id}`, { method: 'DELETE' });
      setReports((prev) => prev.filter((r) => r.id !== id));
    } catch {
      alert('Failed to delete report');
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-divider shadow-sm p-5">
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-divider rounded w-1/2" />
          <div className="h-10 bg-paper-2 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-divider shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-divider bg-paper">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CalendarClock className="w-5 h-5 text-blue-500" />
            <h3 className="font-semibold text-ink">{t('reports.scheduledReports')}</h3>
          </div>
          <button
            onClick={onNewReport}
            className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors"
          >
            + New
          </button>
        </div>
      </div>

      {reports.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <CalendarClock className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-ink-3 mb-2">{t('reports.noReports')}</p>
          <button
            onClick={onNewReport}
            className="text-sm font-medium text-blue-600 hover:text-blue-700 transition-colors"
          >
            Create your first report
          </button>
        </div>
      ) : (
        <div className="divide-y divide-gray-100">
          {reports.map((report) => (
            <div key={report.id} className="px-5 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-ink text-sm truncate">{report.name}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`inline-flex px-1.5 py-0.5 text-xs font-medium rounded ${
                      report.schedule === 'weekly'
                        ? 'bg-blue-50 text-blue-700'
                        : 'bg-purple-50 text-purple-700'
                    }`}>
                      {report.schedule === 'weekly' ? t('reports.weekly') : t('reports.monthly')}
                    </span>
                    {report.next_run && (
                      <span className="text-xs text-ink-3">
                        {t('reports.nextRun')}: {new Date(report.next_run).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 mt-1 text-xs text-ink-3">
                    <Mail className="w-3 h-3" />
                    <span>{report.recipient_emails.length} recipient{report.recipient_emails.length !== 1 ? 's' : ''}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => onEdit(report)}
                    title="Edit"
                    className="p-1.5 text-ink-3 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleSendNow(report.id)}
                    disabled={sendingId === report.id}
                    title={t('reports.sendNow')}
                    className="p-1.5 text-ink-3 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors disabled:opacity-50"
                  >
                    <Send className="w-3.5 h-3.5" />
                  </button>
                  {confirmDeleteId === report.id ? (
                    <button
                      onClick={() => handleDelete(report.id)}
                      disabled={deletingId === report.id}
                      className="px-2 py-1 text-xs font-medium text-signal-critical bg-signal-critical/10 hover:bg-red-100 rounded transition-colors disabled:opacity-50"
                    >
                      {deletingId === report.id ? '...' : 'Confirm'}
                    </button>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(report.id)}
                      title="Delete"
                      className="p-1.5 text-ink-3 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
