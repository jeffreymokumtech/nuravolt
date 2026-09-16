'use client';

import { motion } from 'framer-motion';
import {
  X,
  AlertTriangle,
  Clock,
  Zap,
  TrendingDown,
  Ticket,
  CheckCircle,
  ClipboardCheck,
  Search,
} from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import type {
  Fault,
  ReactiveFault,
  PredictiveFault,
  FaultSeverity,
  FaultUrgency,
} from '@/types/faults';
import type { TicketValidationAction } from '@/types/tickets';
import { FAULT_TYPE_DISPLAY_NAMES } from '@/types/faults';
import { useState } from 'react';
import FaultValidationModal from './FaultValidationModal';
import FaultDataTrack from './FaultDataTrack';
import { LossMethodologyPanel } from '@/components/fault/LossMethodologyPanel';

interface FaultDetailPanelProps {
  fault: Fault | null;
  plantId: string;
  onClose: () => void;
  onCreateTicket: (fault: Fault) => Promise<{ id: string } | { error: string }>;
  onValidateTicket?: (ticketId: string, action: TicketValidationAction, notes?: string) => Promise<boolean>;
}

// Type guards
function isReactiveFault(fault: Fault): fault is ReactiveFault {
  return 'severity' in fault && 'duration_minutes' in fault;
}

function isPredictiveFault(fault: Fault): fault is PredictiveFault {
  return 'urgency' in fault && 'days_to_fault' in fault;
}

// Severity styles
const SEVERITY_STYLES: Record<FaultSeverity, { bg: string; text: string; border: string }> = {
  critical: { bg: 'bg-signal-critical/10', text: 'text-signal-critical', border: 'border-signal-critical/20' },
  warning: { bg: 'bg-yellow-100', text: 'text-yellow-700', border: 'border-yellow-200' },
  info: { bg: 'bg-blue-100', text: 'text-blue-700', border: 'border-blue-200' },
};

// Urgency styles
const URGENCY_STYLES: Record<FaultUrgency, { bg: string; text: string; border: string }> = {
  urgent: { bg: 'bg-signal-critical/10', text: 'text-signal-critical', border: 'border-signal-critical/20' },
  soon: { bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-200' },
  planned: { bg: 'bg-blue-100', text: 'text-blue-700', border: 'border-blue-200' },
  monitoring: { bg: 'bg-paper-2', text: 'text-ink-2', border: 'border-divider' },
};

/**
 * Generate human-readable detection rule explanation for reactive faults.
 * Describes what rule triggered the fault and how the measured value compares to the threshold.
 */
function getDetectionRuleExplanation(fault: ReactiveFault): string {
  // If the fault has an explicit detection_rule field, use that
  if (fault.detection_rule) return fault.detection_rule;

  const v = fault.value;
  const t = fault.threshold;
  const fmtV = v !== null && v !== undefined ? (v < 1 && v > -1 ? (v * 100).toFixed(1) + '%' : Number(v).toFixed(1)) : 'N/A';

  switch (fault.fault_type) {
    case 'bypass_diode_active':
      return `Rule: voltage step drop between 10\u201330V detected on a string, indicating one or more bypass diodes have activated. Measured drop: ${v?.toFixed(1)}V (threshold: ${t}V).`;
    case 'soiling_detected':
      return `Rule: performance ratio under clear-sky conditions fell below ${t !== null ? (t * 100).toFixed(0) : '95'}%. This indicates dust or dirt accumulation reducing panel output. Measured PR: ${v !== null ? (v * 100).toFixed(1) : 'N/A'}%.`;
    case 'inverter_overtemperature':
      return `Rule: inverter cabinet temperature exceeded ${t}\u00B0C safe operating limit. Measured: ${v?.toFixed(1)}\u00B0C. Sustained high temperatures risk automatic shutdown or derating.`;
    case 'inverter_offline':
      return `Rule: AC power output \u2264 0 while irradiance > 200 W/m\u00B2. The inverter is not producing despite sufficient sunlight, indicating a shutdown or communication failure.`;
    case 'inverter_clipping':
      return `Rule: AC power > 95% of rated capacity AND DC/AC power ratio > 1.05. The inverter is limiting output because DC input exceeds its AC conversion capacity.`;
    case 'inverter_efficiency_degradation':
      return `Rule: conversion efficiency (\u03B7 = P_AC / P_DC) dropped below 92%. Measured: ${fmtV}. This indicates internal losses from aging components or partial failures.`;
    case 'inverter_cooling_degradation':
      return `Rule: digital twin thermal residual (actual \u2212 expected temperature) sustained above 5\u00B0C for 48+ hours. The cooling system is underperforming.`;
    case 'string_open_circuit':
      return `Rule: one string current < 0.5A while other strings on the same MPPT produce > 1.0A during daylight (irradiance > 200 W/m\u00B2). Indicates a broken or disconnected string.`;
    case 'string_short_circuit':
      return `Rule: string voltage dropped below 70% of its rolling median. A short circuit reduces voltage significantly while current may spike.`;
    case 'string_mismatch_coarse':
      return `Rule: MPPT power ratio < 85% of the fleet mean. One or more strings are underperforming relative to peers. Measured ratio: ${fmtV}.`;
    case 'mppt_imbalance':
      return `Rule: coefficient of variation across MPPT inputs > 15%. The power difference between MPPT channels indicates uneven string performance.`;
    case 'mppt_hunting':
      return `Rule: voltage oscillations > 10 per hour with amplitude > 5V. The MPPT tracker is failing to converge on the optimal operating point.`;
    case 'tracker_stuck':
      return `Rule: tracker angle standard deviation < 0.1\u00B0 for > 30 minutes during daylight. The tracker is not moving to follow the sun.`;
    case 'tracker_misaligned':
      return `Rule: absolute deviation between tracker angle and optimal solar angle > 10\u00B0. The tracker is pointing in the wrong direction.`;
    case 'grid_frequency_low':
      return `Rule: grid frequency dropped below 49.5 Hz (nominal: 50 Hz). Low frequency indicates grid overload. Measured: ${v?.toFixed(2)} Hz.`;
    case 'grid_frequency_high':
      return `Rule: grid frequency exceeded 50.5 Hz (nominal: 50 Hz). High frequency indicates excess generation. Measured: ${v?.toFixed(2)} Hz.`;
    case 'grid_voltage_sag':
      return `Rule: AC grid voltage dropped below 90% of nominal (${t}V). Voltage sag can cause inverter disconnection. Measured: ${v?.toFixed(1)}V.`;
    case 'grid_voltage_swell':
      return `Rule: AC grid voltage exceeded 110% of nominal (${t}V). Voltage swell can damage equipment. Measured: ${v?.toFixed(1)}V.`;
    case 'grid_curtailment':
      return `Rule: grid frequency > 50.3 Hz while plant is producing, indicating grid-operator curtailment. Power output was reduced to maintain grid stability.`;
    case 'export_cap_active':
      return `Rule: power output held at 99\u2013101% of export limit with coefficient of variation < 2%. The plant is capped at its grid export limit.`;
    case 'module_overtemperature':
      return `Rule: module/cell temperature exceeded ${t}\u00B0C. Extreme temperatures accelerate degradation and reduce output. Measured: ${v?.toFixed(1)}\u00B0C.`;
    case 'communication_loss':
      return `Rule: gap > 15 minutes between consecutive data records. No data was received from this equipment during the gap period.`;
    case 'communication_partial':
      return `Rule: some sensor columns have > 30% null values while others have < 10%. Partial data indicates intermittent communication issues.`;
    case 'sensor_frozen':
      return `Rule: sensor reading standard deviation < 0.01 for > 30 minutes. A constant reading during changing conditions indicates a stuck or failed sensor.`;
    case 'irradiance_sensor_drift':
      return `Rule: measured/clear-sky irradiance ratio consistently deviates > 5% at high irradiance. The irradiance sensor is reading too high or too low.`;
    case 'dc_overvoltage':
      return `Rule: DC voltage exceeded 95% of rated maximum (${t}V). High DC voltage can damage inverter components. Measured: ${v?.toFixed(1)}V.`;
    case 'dc_undervoltage':
      return `Rule: DC voltage dropped below the lower operating margin while inverter is active. Low voltage reduces conversion efficiency. Measured: ${v?.toFixed(1)}V.`;
    case 'unclassified_performance_loss':
      return `Detected by digital twin model: actual power output deviates significantly from physics-based prediction, but no specific fault rule was triggered. The residual loss of ${fmtV} is not explained by any active alarm.`;
    case 'vegetation_shading':
      return `Rule: asymmetric power output between morning and afternoon hours suggests partial shading from nearby vegetation or structures.`;
    case 'insulation_resistance_low':
      return `Rule: insulation resistance (Riso) dropped below IEC 62446 threshold. Low insulation indicates moisture ingress or cable degradation, a ground fault risk.`;
    default:
      return fault.message || 'Detection rule details not available for this fault type.';
  }
}

/**
 * Generate "What Will Happen" warning text for predictive faults.
 * Provides clear, plain language explanation of future impact.
 */
function getWhatWillHappenText(fault: PredictiveFault): string {
  const faultType = fault.fault_type.toLowerCase();
  const daysText = fault.days_to_fault === 1 ? 'tomorrow' : `in ${fault.days_to_fault} days`;
  const lossKwh = fault.projected_energy_loss_kwh.toLocaleString();

  if (faultType.includes('overtemperature') || faultType.includes('thermal')) {
    return `This inverter's temperature is trending upward. If this continues, ${daysText} it will exceed safe operating temperature (${fault.threshold}${fault.unit}). This will cause the inverter to automatically shut down to prevent damage, resulting in ${lossKwh} kWh of lost energy production until it cools down and is inspected.`;
  }

  if (faultType.includes('degradation') || faultType.includes('underperformance')) {
    return `Performance is gradually declining. ${daysText.charAt(0).toUpperCase() + daysText.slice(1)}, this equipment will fall below acceptable performance levels. You can expect to lose ${lossKwh} kWh of energy production. Early intervention now can prevent this loss and extend equipment life.`;
  }

  if (faultType.includes('open_circuit') || faultType.includes('string')) {
    return `A string is showing signs of degradation. ${daysText.charAt(0).toUpperCase() + daysText.slice(1)}, it will likely fail completely and stop producing power. This will result in ${lossKwh} kWh of lost energy until the string is repaired or replaced.`;
  }

  if (faultType.includes('tracker') || faultType.includes('tracking')) {
    return `The tracker system is degrading. ${daysText.charAt(0).toUpperCase() + daysText.slice(1)}, it will likely become stuck or malfunction, preventing panels from following the sun. This will cause a ${lossKwh} kWh reduction in energy production until the tracker is serviced.`;
  }

  if (faultType.includes('inverter') && faultType.includes('cooling')) {
    return `The inverter's cooling system is deteriorating. ${daysText.charAt(0).toUpperCase() + daysText.slice(1)}, it will no longer cool effectively, forcing the inverter to reduce output or shut down during peak hours. This will result in ${lossKwh} kWh of lost peak production.`;
  }

  // Generic predictive warning
  return `Current trends indicate this equipment will experience a fault ${daysText}. If no preventive action is taken, you can expect ${lossKwh} kWh of lost energy production. Taking action now can prevent this fault and associated losses.`;
}

export default function FaultDetailPanel({
  fault,
  plantId,
  onClose,
  onCreateTicket,
  onValidateTicket,
}: FaultDetailPanelProps) {
  const [creatingTicket, setCreatingTicket] = useState(false);
  const [ticketResult, setTicketResult] = useState<{ id: string } | { error: string } | null>(null);
  const [showValidationModal, setShowValidationModal] = useState(false);

  if (!fault) return null;

  const isReactive = isReactiveFault(fault);
  const faultTypeName = FAULT_TYPE_DISPLAY_NAMES[fault.fault_type] || fault.fault_type;

  const handleCreateTicket = async () => {
    setCreatingTicket(true);
    setTicketResult(null);

    const result = await onCreateTicket(fault);
    setTicketResult(result);
    setCreatingTicket(false);
  };

  const formatDate = (dateString: string | null): string => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  };

  const formatDuration = (minutes: number): string => {
    if (minutes < 60) return `${minutes} minutes`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours} hours`;
  };

  return (
    <>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/20 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <motion.div
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
        className="fixed inset-y-0 right-0 w-full sm:w-3/4 lg:w-3/4 max-w-5xl bg-white shadow-xl border-l border-divider z-50 overflow-y-auto"
      >
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-divider p-4 z-10">
          <div className="flex items-start justify-between">
            <div className="flex-1 pr-4">
              <div className="flex items-center gap-2 mb-2">
                {isReactive ? (
                  <span
                    className={`inline-flex px-2 py-1 text-xs font-medium rounded-full border ${
                      SEVERITY_STYLES[(fault as ReactiveFault).severity].bg
                    } ${SEVERITY_STYLES[(fault as ReactiveFault).severity].text} ${
                      SEVERITY_STYLES[(fault as ReactiveFault).severity].border
                    }`}
                  >
                    {(fault as ReactiveFault).severity}
                  </span>
                ) : (
                  <span
                    className={`inline-flex px-2 py-1 text-xs font-medium rounded-full border ${
                      URGENCY_STYLES[(fault as PredictiveFault).urgency].bg
                    } ${URGENCY_STYLES[(fault as PredictiveFault).urgency].text} ${
                      URGENCY_STYLES[(fault as PredictiveFault).urgency].border
                    }`}
                  >
                    {(fault as PredictiveFault).urgency}
                  </span>
                )}
                <span className="px-2 py-1 text-xs font-medium rounded bg-paper-2 text-ink-2">
                  {isReactive ? 'Reactive' : 'Predictive'}
                </span>
              </div>
              <h2 className="text-lg font-bold text-ink">{faultTypeName}</h2>
              <p className="text-sm text-ink-3 mt-1">{fault.equipment_name}</p>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-ink-3" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Two-column layout for wider screens */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
            {/* Left Column - Metrics and Details (2/5 width) */}
            <div className="lg:col-span-2 space-y-6">
              {/* Key Metrics */}
              <div className="grid grid-cols-2 gap-4">
                {isReactive ? (
                  <>
                    <div className="bg-orange-50 rounded-lg p-4 border border-orange-200">
                      <div className="flex items-center gap-2 text-orange-600 mb-2">
                        <Zap className="w-4 h-4" />
                        <span className="text-xs font-medium uppercase">Energy Loss</span>
                      </div>
                      <div className="text-xl font-bold text-ink">
                        {(fault as ReactiveFault).energy_loss_kwh.toLocaleString()} kWh
                      </div>
                    </div>
                    <div className="bg-signal-critical/10 rounded-lg p-4 border border-signal-critical/20">
                      <div className="flex items-center gap-2 text-signal-critical mb-2">
                        <AlertTriangle className="w-4 h-4" />
                        <span className="text-xs font-medium uppercase">Power Loss</span>
                      </div>
                      <div className="text-xl font-bold text-ink">
                        {(fault as ReactiveFault).power_loss_kw.toLocaleString()} kW
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                      <div className="flex items-center gap-2 text-blue-600 mb-2">
                        <TrendingDown className="w-4 h-4" />
                        <span className="text-xs font-medium uppercase">Projected Loss</span>
                      </div>
                      <div className="text-xl font-bold text-ink">
                        {(fault as PredictiveFault).projected_energy_loss_kwh.toLocaleString()} kWh
                      </div>
                    </div>
                    <div className="bg-purple-50 rounded-lg p-4 border border-purple-200">
                      <div className="flex items-center gap-2 text-purple-600 mb-2">
                        <Clock className="w-4 h-4" />
                        <span className="text-xs font-medium uppercase">Days to Fault</span>
                      </div>
                      <div className="text-xl font-bold text-ink">
                        {(fault as PredictiveFault).days_to_fault} days
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Details */}
              <div>
                <h4 className="text-sm font-semibold text-ink-2 mb-3">Details</h4>
                <dl className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <dt className="text-ink-3">Fault Type</dt>
                    <dd className="text-ink font-medium">{faultTypeName}</dd>
                  </div>
                  <div className="flex justify-between text-sm">
                    <dt className="text-ink-3">Equipment ID</dt>
                    <dd className="text-ink font-medium">{fault.equipment_id}</dd>
                  </div>
                  {isReactive ? (
                    <>
                      <div className="flex justify-between text-sm">
                        <dt className="text-ink-3">Start Time</dt>
                        <dd className="text-ink">
                          {formatDate((fault as ReactiveFault).timestamp_start)}
                        </dd>
                      </div>
                      {(fault as ReactiveFault).timestamp_end && (
                        <div className="flex justify-between text-sm">
                          <dt className="text-ink-3">End Time</dt>
                          <dd className="text-ink">
                            {formatDate((fault as ReactiveFault).timestamp_end || null)}
                          </dd>
                        </div>
                      )}
                      <div className="flex justify-between text-sm">
                        <dt className="text-ink-3">Duration</dt>
                        <dd className="text-ink">
                          {formatDuration((fault as ReactiveFault).duration_minutes)}
                        </dd>
                      </div>
                      {(fault as ReactiveFault).value !== null && (
                        <div className="flex justify-between text-sm">
                          <dt className="text-ink-3">Measured Value</dt>
                          <dd className="text-ink font-medium">
                            {(fault as ReactiveFault).value}
                          </dd>
                        </div>
                      )}
                      {(fault as ReactiveFault).threshold !== null && (
                        <div className="flex justify-between text-sm">
                          <dt className="text-ink-3">Threshold</dt>
                          <dd className="text-ink">
                            {(fault as ReactiveFault).threshold}
                          </dd>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="flex justify-between text-sm">
                        <dt className="text-ink-3">Estimated Date</dt>
                        <dd className="text-ink">
                          {formatDate((fault as PredictiveFault).estimated_date)}
                        </dd>
                      </div>
                      <div className="flex justify-between text-sm">
                        <dt className="text-ink-3">Confidence</dt>
                        <dd className="text-ink font-medium">
                          {((fault as PredictiveFault).confidence * 100).toFixed(0)}%
                        </dd>
                      </div>
                      {(fault as PredictiveFault).current_value !== null && (
                        <div className="flex justify-between text-sm">
                          <dt className="text-ink-3">Current Value</dt>
                          <dd className="text-ink font-medium">
                            {(fault as PredictiveFault).current_value} {(fault as PredictiveFault).unit}
                          </dd>
                        </div>
                      )}
                      <div className="flex justify-between text-sm">
                        <dt className="text-ink-3">Threshold</dt>
                        <dd className="text-ink">
                          {(fault as PredictiveFault).threshold} {(fault as PredictiveFault).unit}
                        </dd>
                      </div>
                    </>
                  )}
                </dl>
              </div>

              {/* Message / Recommended Action */}
              <div>
                <h4 className="text-sm font-semibold text-ink-2 mb-2">
                  {isReactive ? 'Message' : 'Recommended Action'}
                </h4>
                <p className="text-sm text-ink-2 bg-paper rounded-lg p-3 border border-divider">
                  {isReactive
                    ? (fault as ReactiveFault).message
                    : (fault as PredictiveFault).recommended_action}
                </p>
              </div>

              {/* Detection Rule Explanation - Reactive Faults Only */}
              {isReactive && (
                <div>
                  <h4 className="text-sm font-semibold text-ink-2 mb-2 flex items-center gap-2">
                    <Search className="w-4 h-4 text-indigo-600" />
                    How This Was Detected
                  </h4>
                  <p className="text-sm text-ink-2 bg-indigo-50 rounded-lg p-3 border border-indigo-200 leading-relaxed">
                    {getDetectionRuleExplanation(fault as ReactiveFault)}
                  </p>
                </div>
              )}

              {/* What Will Happen - Predictive Faults Only */}
              {!isReactive && isPredictiveFault(fault) && (
                <div>
                  <h4 className="text-sm font-semibold text-ink-2 mb-2 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-signal-warning" />
                    What Will Happen
                  </h4>
                  <div className="bg-signal-warning/10 rounded-lg p-4 border border-signal-warning/20">
                    <p className="text-sm text-signal-warning leading-relaxed">
                      {getWhatWillHappenText(fault as PredictiveFault)}
                    </p>
                    <div className="mt-3 pt-3 border-t border-signal-warning/20 flex items-center justify-between text-xs">
                      <div>
                        <span className="text-signal-warning font-semibold">Estimated Impact Date:</span>
                        <span className="ml-2 text-signal-warning">
                          {formatDate((fault as PredictiveFault).estimated_date)}
                        </span>
                      </div>
                      <div className="text-signal-warning">
                        <span className="font-semibold">Confidence:</span>
                        <span className="ml-1 text-signal-warning">
                          {((fault as PredictiveFault).confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Loss Computation Methodology */}
              {fault.loss_computation && (
                <LossMethodologyPanel metadata={fault.loss_computation} />
              )}
            </div>

            {/* Right Column - Data Track Visualization (3/5 width) */}
            <div className="lg:col-span-3">
              <FaultDataTrack fault={fault} plantId={plantId} height={500} />
            </div>
          </div>

          {/* Create Ticket Action */}
          <div className="pt-4 border-t border-divider space-y-3">
            {fault.ticket_id ? (
              <>
                <div className="flex items-center gap-2 text-green-600 bg-green-50 rounded-lg p-4 border border-green-200">
                  <CheckCircle className="w-5 h-5" />
                  <div className="flex-1">
                    <span className="font-medium">Ticket Created</span>
                    <span className="text-sm text-green-500 ml-2">#{fault.ticket_id}</span>
                  </div>
                </div>
                {onValidateTicket && (
                  <button
                    onClick={() => setShowValidationModal(true)}
                    className="w-full flex items-center justify-center gap-2 py-3 bg-paper-2 text-ink-2 rounded-lg hover:bg-gray-200 transition-colors font-medium border border-divider"
                  >
                    <ClipboardCheck className="w-5 h-5" />
                    Validate Ticket
                  </button>
                )}
              </>
            ) : ticketResult && 'id' in ticketResult ? (
              <>
                <div className="flex items-center gap-2 text-green-600 bg-green-50 rounded-lg p-4 border border-green-200">
                  <CheckCircle className="w-5 h-5" />
                  <div className="flex-1">
                    <span className="font-medium">Ticket Created Successfully</span>
                    <span className="text-sm text-green-500 ml-2">#{ticketResult.id}</span>
                  </div>
                </div>
                {onValidateTicket && (
                  <button
                    onClick={() => setShowValidationModal(true)}
                    className="w-full flex items-center justify-center gap-2 py-3 bg-paper-2 text-ink-2 rounded-lg hover:bg-gray-200 transition-colors font-medium border border-divider"
                  >
                    <ClipboardCheck className="w-5 h-5" />
                    Validate Ticket
                  </button>
                )}
              </>
            ) : ticketResult && 'error' in ticketResult ? (
              <div className="text-signal-critical bg-signal-critical/10 rounded-lg p-4 border border-signal-critical/20 mb-4">
                <span className="font-medium">Error: </span>
                <span className="text-sm">{ticketResult.error}</span>
              </div>
            ) : (
              <button
                onClick={handleCreateTicket}
                disabled={creatingTicket}
                className="w-full flex items-center justify-center gap-2 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-400 transition-colors font-medium"
              >
                {creatingTicket ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Creating Ticket...
                  </>
                ) : (
                  <>
                    <Ticket className="w-5 h-5" />
                    Create Maintenance Ticket
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </motion.div>

      {/* Validation Modal */}
      <AnimatePresence>
        {showValidationModal && onValidateTicket && (fault.ticket_id || (ticketResult && 'id' in ticketResult)) && (
          <FaultValidationModal
            ticketId={fault.ticket_id || (ticketResult as { id: string }).id}
            faultType={fault.fault_type}
            onValidate={onValidateTicket}
            onClose={() => setShowValidationModal(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}
