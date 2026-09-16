'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import EmailTagInput from '@/components/ui/EmailTagInput';
import { useLanguage } from '@/contexts/LanguageContext';
import { Battery, Sun, Layers } from 'lucide-react';

// ── Section definitions ──

interface ReportSection {
  id: string;
  label: string;
  description: string;
  category: 'portfolio' | 'bess';
}

const PORTFOLIO_SECTIONS: ReportSection[] = [
  { id: 'portfolio_summary', label: 'Portfolio Summary', description: 'Capacity, revenue, budget deviation, risk score', category: 'portfolio' },
  { id: 'risk_performance', label: 'Plant Risk & Performance', description: 'Per-plant risk scores, health, availability, PR', category: 'portfolio' },
  { id: 'loss_breakdown', label: 'Loss Breakdown', description: 'Per-plant soiling, fault, degradation losses', category: 'portfolio' },
  { id: 'contract_obligations', label: 'Contract Obligations', description: 'PPA, warranty, and SLA obligation status: on track, at risk, breach', category: 'portfolio' },
];

const BESS_SECTIONS: ReportSection[] = [
  { id: 'bess_kpi', label: 'BESS KPIs', description: 'SoH, cycle count, throughput, warranty score, RTE', category: 'bess' },
  { id: 'bess_soh', label: 'SoH Development', description: 'State of health history and projected trajectory', category: 'bess' },
  { id: 'bess_degradation', label: 'Capital Degradation', description: 'Degradation rate, EOL projection, warranty margin', category: 'bess' },
  { id: 'bess_dispatch', label: 'Dispatch Behaviour', description: 'Charge/discharge patterns, revenue, degradation cost', category: 'bess' },
  { id: 'bess_losses', label: 'Loss Disaggregation', description: 'RTE losses, availability, violations', category: 'bess' },
];

const ALL_SECTIONS = [...PORTFOLIO_SECTIONS, ...BESS_SECTIONS];

// ── Component ──

interface ScheduledReportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingReport?: any;
  /** Plant options. Omit to self-fetch the org's plants from /api/plants
   *  (the org reports hub); /demo/portfolio keeps passing its fixture ids. */
  plants?: Array<{ plantId: string; plantName: string }>;
  /** Prefill for "schedule this dashboard" from the editor: the created
   *  report is linked to the dashboard (its rendered PDF is attached). */
  dashboardId?: string | null;
  initialName?: string;
  initialPlantIds?: string[];
  onSaved: () => void;
}

export default function ScheduledReportModal({
  open,
  onOpenChange,
  existingReport,
  plants: plantsProp,
  dashboardId,
  initialName,
  initialPlantIds,
  onSaved,
}: ScheduledReportModalProps) {
  const { t } = useLanguage();
  const isEdit = !!existingReport;

  const [fetchedPlants, setFetchedPlants] = useState<
    Array<{ plantId: string; plantName: string }>
  >([]);
  useEffect(() => {
    if (plantsProp || !open) return;
    let alive = true;
    fetch('/api/plants')
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!alive) return;
        const rows = Array.isArray(json?.data) ? json.data : [];
        setFetchedPlants(
          rows.map((p: any) => ({ plantId: p.slug ?? p.id, plantName: p.name ?? p.slug }))
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [plantsProp, open]);
  const plants = plantsProp ?? fetchedPlants;

  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState<'weekly' | 'monthly'>('weekly');
  const [period, setPeriod] = useState<string>('last_30d');
  const [recipientEmails, setRecipientEmails] = useState<string[]>([]);
  const [reportType, setReportType] = useState<'portfolio' | 'bess' | 'combined'>('portfolio');
  const [selectedSections, setSelectedSections] = useState<string[]>(['portfolio_summary', 'risk_performance', 'loss_breakdown']);
  const [allPlants, setAllPlants] = useState(true);
  const [selectedPlantIds, setSelectedPlantIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [sendDayOfWeek, setSendDayOfWeek] = useState(1); // Monday
  const [sendDayOfMonth, setSendDayOfMonth] = useState(1);
  const [sendTime, setSendTime] = useState('07:00');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  // Populate form when editing
  useEffect(() => {
    if (existingReport) {
      setName(existingReport.name ?? '');
      setSchedule(existingReport.schedule ?? 'weekly');
      setPeriod(existingReport.period ?? 'last_30d');
      setSendDayOfWeek(existingReport.send_day_of_week ?? 1);
      setSendDayOfMonth(existingReport.send_day_of_month ?? 1);
      setSendTime(existingReport.send_time_utc ?? '07:00');
      setCustomStart(existingReport.custom_start ? new Date(existingReport.custom_start).toISOString().split('T')[0] : '');
      setCustomEnd(existingReport.custom_end ? new Date(existingReport.custom_end).toISOString().split('T')[0] : '');
      setRecipientEmails(existingReport.recipient_emails ?? []);
      setReportType(existingReport.report_type ?? 'portfolio');

      // Handle both old (booleans) and new (sections array) format
      if (existingReport.report_sections && Array.isArray(existingReport.report_sections) && existingReport.report_sections.length > 0) {
        setSelectedSections(existingReport.report_sections);
      } else {
        // Backward compat: convert old booleans to sections
        const sections: string[] = [];
        if (existingReport.include_summary !== false) sections.push('portfolio_summary');
        if (existingReport.include_risk !== false) sections.push('risk_performance');
        if (existingReport.include_losses !== false) sections.push('loss_breakdown');
        setSelectedSections(sections);
      }

      const hasAllPlants = !existingReport.plant_ids || existingReport.plant_ids.length === 0;
      setAllPlants(hasAllPlants);
      setSelectedPlantIds(existingReport.plant_ids ?? []);
    } else {
      setName(initialName ?? '');
      setSchedule('weekly');
      setPeriod('last_30d');
      setSendDayOfWeek(1);
      setSendDayOfMonth(1);
      setSendTime('07:00');
      setCustomStart('');
      setCustomEnd('');
      setRecipientEmails([]);
      setReportType('portfolio');
      setSelectedSections(['portfolio_summary', 'risk_performance', 'loss_breakdown']);
      setAllPlants(!initialPlantIds || initialPlantIds.length === 0);
      setSelectedPlantIds(initialPlantIds ?? []);
    }
    // initialPlantIds is keyed by value (not identity) so a parent re-render
    // can't wipe in-progress form input while the dialog is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingReport, open, initialName, (initialPlantIds ?? []).join(',')]);

  const togglePlant = (plantId: string) => {
    setSelectedPlantIds(prev =>
      prev.includes(plantId) ? prev.filter(id => id !== plantId) : [...prev, plantId]
    );
  };

  const toggleSection = (sectionId: string) => {
    setSelectedSections(prev =>
      prev.includes(sectionId) ? prev.filter(id => id !== sectionId) : [...prev, sectionId]
    );
  };

  // Which section categories to show based on report type
  const showPortfolio = reportType === 'portfolio' || reportType === 'combined';
  const showBess = reportType === 'bess' || reportType === 'combined';

  const handleSave = async () => {
    setSaving(true);
    try {
      // Build backward-compatible payload
      const payload = {
        name,
        schedule,
        period,
        report_type: reportType,
        report_sections: selectedSections,
        recipient_emails: recipientEmails,
        plant_ids: allPlants ? [] : selectedPlantIds,
        send_day_of_week: schedule === 'weekly' ? sendDayOfWeek : undefined,
        send_day_of_month: schedule === 'monthly' ? sendDayOfMonth : undefined,
        send_time_utc: sendTime,
        // Editor prefill: link the schedule to the open dashboard so the
        // delivery attaches its rendered PDF. Absent on plain hub creates.
        ...(dashboardId && !isEdit ? { dashboard_id: dashboardId } : {}),
        custom_start: period === 'custom' && customStart ? new Date(customStart).toISOString() : undefined,
        custom_end: period === 'custom' && customEnd ? new Date(customEnd).toISOString() : undefined,
        // Keep old fields for backward compat
        include_summary: selectedSections.includes('portfolio_summary'),
        include_risk: selectedSections.includes('risk_performance'),
        include_losses: selectedSections.includes('loss_breakdown'),
      };

      const url = isEdit ? `/api/reports/${existingReport.id}` : '/api/reports';
      const method = isEdit ? 'PUT' : 'POST';

      await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      onSaved();
    } catch (err) {
      console.error('Failed to save report:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg bg-white max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? 'Edit Scheduled Report' : t('reports.schedule')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Report Name */}
          <div>
            <label className="block text-sm font-medium text-ink-2 mb-1">
              {t('reports.name')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekly Portfolio Summary"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* Report Type */}
          <div>
            <label className="block text-sm font-medium text-ink-2 mb-1">
              Report Type
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { value: 'portfolio' as const, label: 'Portfolio', icon: Sun, color: 'text-signal-warning bg-signal-warning/10 border-signal-warning/20' },
                { value: 'bess' as const, label: 'BESS', icon: Battery, color: 'text-green-600 bg-green-50 border-green-200' },
                { value: 'combined' as const, label: 'Combined', icon: Layers, color: 'text-blue-600 bg-blue-50 border-blue-200' },
              ].map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setReportType(opt.value)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border-2 text-sm font-medium transition-all ${
                    reportType === opt.value
                      ? opt.color
                      : 'border-divider text-ink-3 hover:border-gray-300'
                  }`}
                >
                  <opt.icon className="w-4 h-4" />
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Schedule + Period row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-ink-2 mb-1">
                {t('reports.frequency')}
              </label>
              <Select value={schedule} onValueChange={(v: 'weekly' | 'monthly') => setSchedule(v)}>
                <SelectTrigger className="w-full rounded-lg border-gray-300">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">{t('reports.weekly')}</SelectItem>
                  <SelectItem value="monthly">{t('reports.monthly')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-2 mb-1">
                {t('reports.period')}
              </label>
              <Select value={period} onValueChange={(v: string) => setPeriod(v)}>
                <SelectTrigger className="w-full rounded-lg border-gray-300">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="last_7d">{t('reports.last7d')}</SelectItem>
                  <SelectItem value="last_14d">Last 14 Days</SelectItem>
                  <SelectItem value="last_30d">{t('reports.last30d')}</SelectItem>
                  <SelectItem value="last_month">{t('reports.lastMonth')}</SelectItem>
                  <SelectItem value="last_quarter">Last Quarter</SelectItem>
                  <SelectItem value="year_to_date">Year to Date</SelectItem>
                  <SelectItem value="custom">Custom Range</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Custom date range (shown when period is 'custom') */}
          {period === 'custom' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-ink-2 mb-1">Start Date</label>
                <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-2 mb-1">End Date</label>
                <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
          )}

          {/* Send Day & Time */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-ink-2 mb-1">
                {schedule === 'weekly' ? 'Send Day' : 'Day of Month'}
              </label>
              {schedule === 'weekly' ? (
                <Select value={String(sendDayOfWeek)} onValueChange={(v) => setSendDayOfWeek(parseInt(v))}>
                  <SelectTrigger className="w-full rounded-lg border-gray-300"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {/* ISO day numbers (the API's contract): 1 = Monday .. 7 = Sunday */}
                    {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>{day}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Select value={String(sendDayOfMonth)} onValueChange={(v) => setSendDayOfMonth(parseInt(v))}>
                  <SelectTrigger className="w-full rounded-lg border-gray-300"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 28 }, (_, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>{i + 1}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-2 mb-1">Send Time (UTC)</label>
              <input type="time" value={sendTime} onChange={(e) => setSendTime(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>

          {/* Recipient Emails, Tag Input */}
          <div>
            <label className="block text-sm font-medium text-ink-2 mb-1">
              {t('reports.recipients')}
            </label>
            <EmailTagInput
              emails={recipientEmails}
              onChange={setRecipientEmails}
              placeholder="Type email and press Enter..."
            />
            <p className="text-xs text-ink-3 mt-1">Press Enter, comma, or Tab to add. Paste a list to add multiple.</p>
          </div>

          {/* Plant Selection */}
          <div>
            <label className="block text-sm font-medium text-ink-2 mb-1">
              {t('reports.plants')}
            </label>
            <div className="border border-divider rounded-lg p-3 max-h-40 overflow-y-auto space-y-2">
              <label className="flex items-center gap-2 pb-2 border-b border-divider">
                <input
                  type="checkbox"
                  checked={allPlants}
                  onChange={(e) => setAllPlants(e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm font-medium text-ink">{t('reports.allPlants')}</span>
              </label>
              {plants.map((plant) => (
                <label key={plant.plantId} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={allPlants || selectedPlantIds.includes(plant.plantId)}
                    disabled={allPlants}
                    onChange={() => togglePlant(plant.plantId)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                  />
                  <span className={`text-sm ${allPlants ? 'text-ink-3' : 'text-ink-2'}`}>
                    {plant.plantName}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Report Sections, Categorized */}
          <div>
            <label className="block text-sm font-medium text-ink-2 mb-2">
              {t('reports.sections')}
            </label>
            <div className="space-y-4">
              {/* Portfolio sections */}
              {showPortfolio && (
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Sun className="w-3.5 h-3.5 text-amber-500" />
                    <span className="text-xs font-semibold text-ink-3 uppercase tracking-wide">Portfolio</span>
                  </div>
                  <div className="space-y-1.5">
                    {PORTFOLIO_SECTIONS.map(section => (
                      <label key={section.id} className="flex items-start gap-2 p-2 rounded-lg hover:bg-gray-50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedSections.includes(section.id)}
                          onChange={() => toggleSection(section.id)}
                          className="mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <div>
                          <span className="text-sm font-medium text-ink">{section.label}</span>
                          <p className="text-xs text-ink-3">{section.description}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* BESS sections */}
              {showBess && (
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Battery className="w-3.5 h-3.5 text-green-500" />
                    <span className="text-xs font-semibold text-ink-3 uppercase tracking-wide">Battery Storage</span>
                  </div>
                  <div className="space-y-1.5">
                    {BESS_SECTIONS.map(section => (
                      <label key={section.id} className="flex items-start gap-2 p-2 rounded-lg hover:bg-gray-50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedSections.includes(section.id)}
                          onChange={() => toggleSection(section.id)}
                          className="mt-0.5 rounded border-gray-300 text-green-600 focus:ring-green-500"
                        />
                        <div>
                          <span className="text-sm font-medium text-ink">{section.label}</span>
                          <p className="text-xs text-ink-3">{section.description}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <button
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 text-sm font-medium text-ink-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim() || recipientEmails.length === 0 || selectedSections.length === 0}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : isEdit ? 'Update Report' : 'Create Report'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
