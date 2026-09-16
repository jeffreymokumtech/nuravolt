'use client';

import { useState, useEffect } from 'react';
import {
  FileText,
  AlertTriangle,
  Wrench,
  Droplets,
  ChevronDown,
  ChevronUp,
  Calendar,
  Radio,
} from 'lucide-react';
import { QUALITY_COLORS } from './constants';
import { useDataRoot } from '@/contexts/DataSourceContext';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

interface InverterIssue {
  inverterId: string;
  status: string;
  description: string;
  reportedDate: string;
}

interface CleaningEvent {
  date: string;
  type: string;
  scope: string;
  notes: string;
  affectedInverters?: string[];
  verified?: boolean;
}

interface SensorNote {
  date: string;
  type: string;
  description: string;
  inverters?: string[];
}

interface PlantNotes {
  plantId: string;
  lastUpdated: string;
  inverterIssues?: InverterIssue[];
  cleaningEvents?: CleaningEvent[];
  sensorNotes?: SensorNote[];
}

interface PlantNotesCardProps {
  plantId: string;
  className?: string;
}

export default function PlantNotesCard({ plantId, className = '' }: PlantNotesCardProps) {
  const [notes, setNotes] = useState<PlantNotes | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(true);
  const dataRoot = useDataRoot();
  const prefix = usePlantRoutePrefix();

  useEffect(() => {
    // Operator-notes fixtures only exist for demo/showcase plants.
    if (prefix === '/dashboard') {
      setNotes(null);
      setIsLoading(false);
      return;
    }
    const fetchNotes = async () => {
      try {
        const res = await fetch(`${dataRoot}/soiling/${plantId}/plant_notes.json`);
        if (res.ok) {
          const data = await res.json();
          setNotes(data);
        } else {
          // Missing notes file is an expected state for plants without operator notes.
          setNotes(null);
        }
      } catch (err) {
        // Network/parse error, fall through to calm empty state.
        setNotes(null);
      } finally {
        setIsLoading(false);
      }
    };
    fetchNotes();
  }, [plantId, dataRoot, prefix]);

  if (isLoading) return null;

  const hasContent =
    !!notes &&
    (
      (notes.inverterIssues && notes.inverterIssues.length > 0) ||
      (notes.cleaningEvents && notes.cleaningEvents.length > 0) ||
      (notes.sensorNotes && notes.sensorNotes.length > 0)
    );

  return (
    <div
      className={`bg-white rounded-xl border p-4 ${className}`}
      style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
    >
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between"
      >
        <h3
          className="text-sm font-medium flex items-center gap-2"
          style={{ color: QUALITY_COLORS.text.secondary }}
        >
          <FileText className="w-4 h-4" />
          Plant Notes & Events
        </h3>
        {isExpanded ? (
          <ChevronUp className="w-4 h-4" style={{ color: QUALITY_COLORS.text.muted }} />
        ) : (
          <ChevronDown className="w-4 h-4" style={{ color: QUALITY_COLORS.text.muted }} />
        )}
      </button>

      {isExpanded && !hasContent && (
        <p
          className="mt-3 text-sm"
          style={{ color: QUALITY_COLORS.text.muted }}
        >
          No operator notes recorded for this plant.
        </p>
      )}

      {isExpanded && hasContent && (
        <div className="mt-4 space-y-4">
          {/* Inverter Issues */}
          {notes.inverterIssues && notes.inverterIssues.length > 0 && (
            <div>
              <h4
                className="text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-1.5"
                style={{ color: QUALITY_COLORS.status.fair }}
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                Inverter Issues
              </h4>
              <div className="space-y-2">
                {notes.inverterIssues.map((issue, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-lg flex items-start gap-3"
                    style={{ backgroundColor: `${QUALITY_COLORS.status.fair}10` }}
                  >
                    <Radio
                      className="w-4 h-4 mt-0.5 flex-shrink-0"
                      style={{ color: QUALITY_COLORS.status.fair }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className="font-mono font-semibold text-sm"
                          style={{ color: QUALITY_COLORS.text.primary }}
                        >
                          {issue.inverterId}
                        </span>
                        <span
                          className="px-1.5 py-0.5 rounded text-xs font-medium"
                          style={{
                            backgroundColor: QUALITY_COLORS.status.fair,
                            color: 'white',
                          }}
                        >
                          {issue.status.replace('_', ' ')}
                        </span>
                      </div>
                      <p
                        className="text-sm mt-1"
                        style={{ color: QUALITY_COLORS.text.secondary }}
                      >
                        {issue.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Cleaning Events */}
          {notes.cleaningEvents && notes.cleaningEvents.length > 0 && (
            <div>
              <h4
                className="text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-1.5"
                style={{ color: QUALITY_COLORS.primary.DEFAULT }}
              >
                <Droplets className="w-3.5 h-3.5" />
                Cleaning Events
              </h4>
              <div className="space-y-2">
                {notes.cleaningEvents.map((event, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-lg"
                    style={{ backgroundColor: QUALITY_COLORS.background.section }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Calendar
                        className="w-3.5 h-3.5"
                        style={{ color: QUALITY_COLORS.text.muted }}
                      />
                      <span
                        className="text-sm font-medium"
                        style={{ color: QUALITY_COLORS.text.primary }}
                      >
                        {event.date}
                      </span>
                      <span
                        className="px-1.5 py-0.5 rounded text-xs"
                        style={{
                          backgroundColor: `${QUALITY_COLORS.primary.DEFAULT}15`,
                          color: QUALITY_COLORS.primary.DEFAULT,
                        }}
                      >
                        {event.type.replace('_', ' ')}
                      </span>
                      {event.verified === false && (
                        <span
                          className="px-1.5 py-0.5 rounded text-xs"
                          style={{
                            backgroundColor: `${QUALITY_COLORS.status.fair}15`,
                            color: QUALITY_COLORS.status.fair,
                          }}
                        >
                          unverified
                        </span>
                      )}
                    </div>
                    <p
                      className="text-sm"
                      style={{ color: QUALITY_COLORS.text.secondary }}
                    >
                      {event.notes}
                    </p>
                    {event.affectedInverters && event.affectedInverters.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {event.affectedInverters.map((inv) => (
                          <span
                            key={inv}
                            className="px-2 py-0.5 rounded text-xs font-mono"
                            style={{
                              backgroundColor: QUALITY_COLORS.background.hover,
                              color: QUALITY_COLORS.text.secondary,
                            }}
                          >
                            {inv}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sensor Notes */}
          {notes.sensorNotes && notes.sensorNotes.length > 0 && (
            <div>
              <h4
                className="text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-1.5"
                style={{ color: QUALITY_COLORS.text.secondary }}
              >
                <Wrench className="w-3.5 h-3.5" />
                Sensor Notes
              </h4>
              <div className="space-y-2">
                {notes.sensorNotes.map((note, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-lg border"
                    style={{
                      backgroundColor: QUALITY_COLORS.background.section,
                      borderColor: QUALITY_COLORS.border.light,
                    }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="text-xs"
                        style={{ color: QUALITY_COLORS.text.muted }}
                      >
                        {note.date}
                      </span>
                      <span
                        className="px-1.5 py-0.5 rounded text-xs"
                        style={{
                          backgroundColor: `${QUALITY_COLORS.status.fair}15`,
                          color: QUALITY_COLORS.status.fair,
                        }}
                      >
                        {note.type.replace('_', ' ')}
                      </span>
                    </div>
                    <p
                      className="text-sm"
                      style={{ color: QUALITY_COLORS.text.primary }}
                    >
                      {note.description}
                    </p>
                    {note.inverters && note.inverters.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {note.inverters.map((inv) => (
                          <span
                            key={inv}
                            className="px-2 py-0.5 rounded text-xs font-mono font-medium"
                            style={{
                              backgroundColor: `${QUALITY_COLORS.status.fair}15`,
                              color: QUALITY_COLORS.status.fair,
                            }}
                          >
                            {inv}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Last updated */}
          {notes && (
            <p
              className="text-xs pt-2"
              style={{ color: QUALITY_COLORS.text.muted }}
            >
              Last updated: {notes.lastUpdated}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
