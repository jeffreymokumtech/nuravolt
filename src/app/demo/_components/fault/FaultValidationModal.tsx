'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle, XCircle, Edit, Copy, Slash, X } from 'lucide-react';
import type { TicketValidationAction } from '@/types/tickets';

interface FaultValidationModalProps {
  ticketId: string;
  faultType: string;
  onValidate: (ticketId: string, action: TicketValidationAction, notes?: string) => Promise<boolean>;
  onClose: () => void;
}

const VALIDATION_OPTIONS: {
  action: TicketValidationAction;
  label: string;
  description: string;
  icon: typeof CheckCircle;
  color: string;
  bgColor: string;
}[] = [
  {
    action: 'VALIDATED_CORRECT',
    label: 'Validate as Correct',
    description: 'Confirm the fault is real and needs action',
    icon: CheckCircle,
    color: 'text-green-600',
    bgColor: 'bg-green-50 border-green-200 hover:bg-green-100',
  },
  {
    action: 'VALIDATED_ADJUSTED',
    label: 'Validate with Adjustments',
    description: 'Fault is valid but severity/details need correction',
    icon: Edit,
    color: 'text-blue-600',
    bgColor: 'bg-blue-50 border-blue-200 hover:bg-blue-100',
  },
  {
    action: 'DISMISSED_FALSE_POSITIVE',
    label: 'Dismiss: False Positive',
    description: 'No real fault - detection system error',
    icon: XCircle,
    color: 'text-signal-critical',
    bgColor: 'bg-signal-critical/10 border-signal-critical/20 hover:bg-red-100',
  },
  {
    action: 'DISMISSED_DUPLICATE',
    label: 'Dismiss: Duplicate',
    description: 'Already tracked in another ticket',
    icon: Copy,
    color: 'text-orange-600',
    bgColor: 'bg-orange-50 border-orange-200 hover:bg-orange-100',
  },
  {
    action: 'DISMISSED_NOT_ACTIONABLE',
    label: 'Dismiss: Not Actionable',
    description: 'Cannot or should not take action',
    icon: Slash,
    color: 'text-ink-2',
    bgColor: 'bg-paper border-divider hover:bg-gray-100',
  },
];

export default function FaultValidationModal({
  ticketId,
  faultType,
  onValidate,
  onClose,
}: FaultValidationModalProps) {
  const [selectedAction, setSelectedAction] = useState<TicketValidationAction | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!selectedAction) return;

    setSubmitting(true);
    setError(null);

    try {
      const success = await onValidate(ticketId, selectedAction, notes || undefined);
      if (success) {
        onClose();
      } else {
        setError('Failed to validate ticket. Please try again.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/50 z-50"
        onClick={onClose}
      />

      {/* Modal */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="fixed inset-0 flex items-center justify-center z-50 p-4"
      >
        <div
          className="bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-divider flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-ink">Validate Fault Ticket</h3>
              <p className="text-sm text-ink-3 mt-0.5">
                {faultType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-ink-3" />
            </button>
          </div>

          {/* Body */}
          <div className="px-6 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
            <p className="text-sm text-ink-2">
              Your feedback helps improve our fault detection algorithms. Select how this fault should be classified:
            </p>

            {/* Validation Options */}
            <div className="space-y-2">
              {VALIDATION_OPTIONS.map((option) => {
                const Icon = option.icon;
                const isSelected = selectedAction === option.action;

                return (
                  <motion.button
                    key={option.action}
                    whileHover={{ scale: 1.01 }}
                    whileTap={{ scale: 0.99 }}
                    onClick={() => setSelectedAction(option.action)}
                    className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all ${
                      isSelected
                        ? 'border-blue-500 ring-2 ring-blue-200 bg-blue-50'
                        : `border ${option.bgColor}`
                    }`}
                  >
                    <Icon className={`w-5 h-5 flex-shrink-0 ${option.color}`} />
                    <div className="text-left flex-1">
                      <div className="font-medium text-ink">{option.label}</div>
                      <div className="text-xs text-ink-3">{option.description}</div>
                    </div>
                    {isSelected && (
                      <div className="w-2 h-2 bg-blue-600 rounded-full" />
                    )}
                  </motion.button>
                );
              })}
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm font-medium text-ink-2 mb-1">
                Notes (optional)
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add any additional context or feedback..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
                rows={3}
              />
            </div>

            {/* Error */}
            {error && (
              <div className="text-sm text-signal-critical bg-signal-critical/10 border border-signal-critical/20 rounded-lg p-3">
                {error}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-divider flex gap-3">
            <button
              onClick={onClose}
              disabled={submitting}
              className="flex-1 py-2.5 text-ink-2 bg-paper-2 rounded-lg hover:bg-gray-200 transition-colors font-medium disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!selectedAction || submitting}
              className="flex-1 py-2.5 text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-medium flex items-center justify-center gap-2"
            >
              {submitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Submitting...
                </>
              ) : (
                'Submit Feedback'
              )}
            </button>
          </div>
        </div>
      </motion.div>
    </>
  );
}
