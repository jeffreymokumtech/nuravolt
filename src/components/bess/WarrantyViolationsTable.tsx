'use client';

import { useState } from 'react';
import type { WarrantyViolation, WarrantyViolationType, ViolationSeverity } from '@/types/bess';
import { VIOLATION_TYPE_NAMES, SEVERITY_COLORS } from '@/types/bess';

interface WarrantyViolationsTableProps {
  violations: WarrantyViolation[];
  loading?: boolean;
  onResolve?: (violationId: string) => void;
}

export default function WarrantyViolationsTable({
  violations,
  loading,
  onResolve,
}: WarrantyViolationsTableProps) {
  const [filter, setFilter] = useState<'all' | 'active' | 'resolved'>('all');
  const [sortBy, setSortBy] = useState<'date' | 'severity'>('date');

  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-48 mb-4" />
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 bg-gray-200 rounded" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Filter violations
  const filteredViolations = violations.filter((v) => {
    if (filter === 'active') return !v.isResolved;
    if (filter === 'resolved') return v.isResolved;
    return true;
  });

  // Sort violations
  const sortedViolations = [...filteredViolations].sort((a, b) => {
    if (sortBy === 'severity') {
      const severityOrder = { critical: 0, warning: 1 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    }
    return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
  });

  const activeCount = violations.filter((v) => !v.isResolved).length;
  const criticalCount = violations.filter((v) => v.severity === 'critical').length;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Warranty Violations</h3>
          <p className="text-sm text-gray-500">
            {activeCount} active
            {criticalCount > 0 && (
              <span className="text-red-600 ml-2">({criticalCount} critical)</span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as any)}
            className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All ({violations.length})</option>
            <option value="active">Active ({activeCount})</option>
            <option value="resolved">Resolved ({violations.length - activeCount})</option>
          </select>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="date">Sort by Date</option>
            <option value="severity">Sort by Severity</option>
          </select>
        </div>
      </div>

      {sortedViolations.length === 0 ? (
        <div className="text-center py-8">
          <div className="text-4xl mb-2">&#10003;</div>
          <p className="text-gray-600">
            {filter === 'all' ? 'No violations recorded' : `No ${filter} violations`}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left text-sm font-medium text-gray-500 pb-3">Type</th>
                <th className="text-left text-sm font-medium text-gray-500 pb-3">Severity</th>
                <th className="text-left text-sm font-medium text-gray-500 pb-3">Started</th>
                <th className="text-left text-sm font-medium text-gray-500 pb-3">Duration</th>
                <th className="text-left text-sm font-medium text-gray-500 pb-3">Value</th>
                <th className="text-left text-sm font-medium text-gray-500 pb-3">Status</th>
                {onResolve && <th className="text-right text-sm font-medium text-gray-500 pb-3">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sortedViolations.map((violation) => (
                <ViolationRow
                  key={violation.id}
                  violation={violation}
                  onResolve={onResolve}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ViolationRow({
  violation,
  onResolve,
}: {
  violation: WarrantyViolation;
  onResolve?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatDuration = (minutes: number | null) => {
    if (!minutes) return '-';
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
    return `${Math.round(minutes / 1440)}d`;
  };

  return (
    <>
      <tr
        className={`hover:bg-gray-50 cursor-pointer transition-colors ${
          !violation.isResolved ? 'bg-yellow-50/30' : ''
        }`}
        onClick={() => setExpanded(!expanded)}
      >
        <td className="py-3">
          <span className="font-medium text-gray-900">
            {VIOLATION_TYPE_NAMES[violation.violationType] || violation.violationType}
          </span>
        </td>
        <td className="py-3">
          <span
            className="px-2 py-1 rounded-full text-xs font-medium text-white"
            style={{ backgroundColor: SEVERITY_COLORS[violation.severity] }}
          >
            {violation.severity}
          </span>
        </td>
        <td className="py-3 text-sm text-gray-600">{formatDate(violation.startedAt)}</td>
        <td className="py-3 text-sm text-gray-600">{formatDuration(violation.durationMinutes)}</td>
        <td className="py-3 text-sm">
          {violation.measuredValue !== null ? (
            <span>
              <span className="font-medium text-gray-900">
                {violation.measuredValue.toFixed(2)}
              </span>
              {violation.unit && <span className="text-gray-500 ml-1">{violation.unit}</span>}
              {violation.thresholdValue !== null && (
                <span className="text-gray-400 ml-1">
                  / {violation.thresholdValue.toFixed(2)}
                </span>
              )}
            </span>
          ) : (
            '-'
          )}
        </td>
        <td className="py-3">
          {violation.isResolved ? (
            <span className="text-green-600 text-sm">Resolved</span>
          ) : (
            <span className="text-amber-600 text-sm font-medium">Active</span>
          )}
        </td>
        {onResolve && (
          <td className="py-3 text-right">
            {!violation.isResolved && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onResolve(violation.id);
                }}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                Resolve
              </button>
            )}
          </td>
        )}
      </tr>
      {expanded && (
        <tr className="bg-gray-50">
          <td colSpan={onResolve ? 7 : 6} className="py-3 px-4">
            <div className="text-sm space-y-2">
              {violation.description && (
                <p className="text-gray-700">{violation.description}</p>
              )}
              {violation.rootCause && (
                <p className="text-gray-600">
                  <span className="font-medium">Root Cause:</span> {violation.rootCause}
                </p>
              )}
              {violation.resolutionNotes && (
                <p className="text-green-700">
                  <span className="font-medium">Resolution:</span> {violation.resolutionNotes}
                </p>
              )}
              {violation.endedAt && (
                <p className="text-gray-500 text-xs">
                  Ended: {formatDate(violation.endedAt)}
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
