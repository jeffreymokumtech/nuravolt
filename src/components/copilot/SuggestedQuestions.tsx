'use client';

import { MessageSquarePlus } from 'lucide-react';
import { useCopilotOptional } from './CopilotProvider';

/**
 * Context-aware suggested-question chips for the chat empty state. Clicking
 * only PRE-FILLS the input via seedNextMessage — send stays manual, so the
 * chips are safe everywhere the input is (they never fire a request
 * themselves). Question sets follow the asset type and page scope.
 */

export function questionsFor(scope: {
  assetType?: string;
  plantName?: string;
  inverterId?: string;
}): string[] {
  const plant = scope.plantName ?? 'this plant';
  if (scope.inverterId) {
    return [
      `Diagnose inverter ${scope.inverterId}`,
      `What is inverter ${scope.inverterId} losing per day?`,
      `Draft a ticket for inverter ${scope.inverterId}`,
    ];
  }
  const type = (scope.assetType ?? '').toUpperCase();
  if (type.includes('BESS') || type.includes('STORAGE') || type.includes('BATTERY')) {
    return [
      `What did ${plant} earn this week, and from which services?`,
      `How is the battery's state of health trending?`,
      `Which service was the top earner this month?`,
    ];
  }
  if (type.includes('WIND')) {
    return [
      `How is availability at ${plant} this month?`,
      `Any turbines underperforming their power curve?`,
    ];
  }
  if (type.includes('SOLAR') || type.includes('PV') || scope.plantName) {
    return [
      `When should we clean ${plant}, and is it worth it?`,
      `Which inverters are underperforming right now?`,
      `Any faults developing I should plan work for?`,
    ];
  }
  return [
    'What plants do I have?',
    'Which plant is losing the most to soiling?',
    'Show my open tickets by priority',
  ];
}

/** Presentational chip list — used directly where no CopilotProvider exists. */
export function SuggestedQuestionChips({
  questions,
  onPick,
}: {
  questions: string[];
  onPick: (text: string) => void;
}) {
  if (questions.length === 0) return null;
  return (
    <div className="mt-4 flex flex-wrap justify-center gap-1.5">
      {questions.map((q) => (
        <button
          key={q}
          type="button"
          onClick={() => onPick(q)}
          className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-3 py-1.5 text-[11px] font-medium text-gray-700 shadow-sm hover:border-blue-400 hover:text-blue-700"
        >
          <MessageSquarePlus className="h-3 w-3 text-gray-400" aria-hidden />
          {q}
        </button>
      ))}
    </div>
  );
}

/** Copilot-wired variant: derives questions from the rail's resolved scope. */
export function SuggestedQuestions() {
  const copilot = useCopilotOptional();
  if (!copilot) return null;
  return (
    <SuggestedQuestionChips
      questions={questionsFor(copilot.resolvedScope ?? {})}
      onPick={(q) => copilot.seedNextMessage(q)}
    />
  );
}
