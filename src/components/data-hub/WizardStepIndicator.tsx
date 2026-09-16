'use client';

import { Check } from 'lucide-react';
import { canEnterStep, type WizardStepDef, type WizardSnapshot } from './wizard-steps';

interface Props {
  steps: WizardStepDef[];
  currentStep: number;
  snapshot: WizardSnapshot;
  visited: Set<number>;
  onSelect: (id: number) => void;
}

/**
 * Clickable step indicator — replaces the visual-only dot bar. Skipped steps
 * are omitted entirely (numbering follows the visible list); enterable steps
 * are buttons, unreachable ones render disabled.
 */
export default function WizardStepIndicator({ steps, currentStep, snapshot, visited, onSelect }: Props) {
  const visible = steps.filter((step) => !step.isSkipped(snapshot));

  return (
    <div className="px-6 py-3 bg-gray-50 border-b border-gray-200">
      <div className="flex items-center justify-between">
        {visible.map((step, index) => {
          const isCurrent = currentStep === step.id;
          const isDone = !isCurrent && step.isComplete(snapshot) && visited.has(step.id);
          const enterable = !isCurrent && canEnterStep(steps, step.id, snapshot, visited);

          return (
            <div key={step.id} className="flex items-center">
              <button
                type="button"
                disabled={!enterable && !isCurrent}
                onClick={() => enterable && onSelect(step.id)}
                title={step.name}
                aria-label={`Step ${index + 1}: ${step.name}`}
                aria-current={isCurrent ? 'step' : undefined}
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors
                  ${isCurrent ? 'bg-blue-600 text-white'
                  : isDone ? 'bg-green-500 text-white'
                  : 'bg-gray-200 text-gray-500'}
                  ${enterable ? 'cursor-pointer hover:ring-2 hover:ring-blue-300' : isCurrent ? '' : 'cursor-not-allowed'}`}
              >
                {isDone ? <Check className="w-5 h-5" /> : index + 1}
              </button>
              {index < visible.length - 1 && (
                <div className={`w-12 h-1 mx-1 ${currentStep > step.id ? 'bg-green-500' : 'bg-gray-200'}`} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
