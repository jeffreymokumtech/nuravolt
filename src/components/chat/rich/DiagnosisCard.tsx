'use client';

import { RichToolCard, StatCell } from './RichToolCard';
import { useCopilotOptional } from '@/components/copilot/CopilotProvider';

/**
 * Structured evidence card for `tool-getInverterClassification` (rule engine)
 * and `tool-getInverterDiagnosis` (AI deep dive) outputs — replaces the raw
 * JSON dump. Two shape adapters, one visual language.
 */

type Tone = 'ok' | 'warn' | 'alarm' | 'info';

function causeTone(cause?: string, action?: string): Tone {
  const c = (cause ?? '').toUpperCase();
  const a = (action ?? '').toUpperCase();
  if (a.includes('REPLACE') || c.includes('FAILURE') || c.includes('ELECTRICAL')) return 'alarm';
  if (a.includes('CLEAN') || c.includes('SOILING')) return 'warn';
  if (c === 'NORMAL' || a === 'MONITOR' || a === 'NONE') return 'ok';
  return 'info';
}

function severityTone(sev?: string): Tone {
  const s = (sev ?? '').toLowerCase();
  if (s.includes('critical') || s.includes('high')) return 'alarm';
  if (s.includes('medium') || s.includes('warn')) return 'warn';
  if (s.includes('low') || s.includes('normal') || s.includes('info')) return 'ok';
  return 'info';
}

const label = (s: unknown) =>
  String(s ?? '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^\w/, (m) => m.toUpperCase());

/**
 * One-click "open work order" that hands the diagnosis to Shams as a prefilled
 * message; Shams then drafts a ticket (proposeTicket) the user confirms. Hidden
 * outside the copilot rail (no seed target).
 */
function WorkOrderButton({ seed }: { seed: string }) {
  const copilot = useCopilotOptional();
  if (!copilot) return null;
  return (
    <div className="mt-2 flex justify-end">
      <button
        type="button"
        onClick={() => copilot.seedNextMessage(seed)}
        className="rounded border border-blue-300 bg-white px-2.5 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-50"
      >
        Open work order
      </button>
    </div>
  );
}

/** Rule-engine classification: likelyCause/confidence/etaDays/evidence/recommendedAction. */
export function ClassificationResult({ output }: { output: any }) {
  if (!output?.likelyCause) return null;
  return (
    <RichToolCard
      title={`Classification · ${output.inverterId ?? 'inverter'}`}
      badge={label(output.likelyCause)}
      badgeTone={causeTone(output.likelyCause, output.recommendedAction)}
      raw={output}
    >
      <div className="mb-2 grid grid-cols-3 gap-2">
        <StatCell
          label="Confidence"
          value={typeof output.confidence === 'number' ? `${Math.round(output.confidence * 100)}%` : 'n/a'}
        />
        <StatCell label="ETA" value={output.etaDays != null ? `${output.etaDays}d` : 'monitor'} />
        <StatCell
          label="Loss at risk"
          value={
            output.projectedEnergyLossKwhPerDay != null
              ? `${Number(output.projectedEnergyLossKwhPerDay).toFixed(1)} kWh/d`
              : 'n/a'
          }
        />
      </div>
      {Array.isArray(output.evidence) && output.evidence.length > 0 && (
        <ul className="mb-2 space-y-1">
          {output.evidence.map((e: string, i: number) => (
            <li key={i} className="flex gap-1.5 text-[11px] text-gray-700">
              <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-gray-400" />
              {e}
            </li>
          ))}
        </ul>
      )}
      {output.recommendedAction && (
        <div className="rounded-md bg-gray-50 px-2 py-1.5 text-[11px] text-gray-800">
          <span className="font-medium">Recommended:</span> {label(output.recommendedAction)}
        </div>
      )}
      <WorkOrderButton
        seed={`Open a maintenance ticket for ${output.inverterId ?? 'this inverter'}: ${label(output.likelyCause)}${
          output.recommendedAction ? `, recommended action ${label(output.recommendedAction)}` : ''
        }.`}
      />
    </RichToolCard>
  );
}

/** AI deep dive: { diagnosis: { summary, severity, actions[], fault_hypothesis }, ... }. */
export function DiagnosisResult({ output }: { output: any }) {
  const d = output?.diagnosis;
  if (!d?.summary) return null;
  const hypothesis = d.fault_hypothesis;
  return (
    <RichToolCard
      title={`AI diagnosis · ${output.inverterId ?? 'inverter'}`}
      badge={label(d.severity ?? 'info')}
      badgeTone={severityTone(d.severity)}
      raw={output}
    >
      <p className="mb-2 text-[11.5px] leading-relaxed text-gray-800">{d.summary}</p>
      {hypothesis && typeof hypothesis === 'object' && (
        <div className="mb-2 grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-gray-100 bg-gray-50 px-2 py-1.5">
          {Object.entries(hypothesis)
            .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
            .slice(0, 6)
            .map(([k, v]) => (
              <div key={k} className="text-[10.5px]">
                <span className="text-gray-500">{label(k)}: </span>
                <span className="font-mono text-gray-800">{String(v)}</span>
              </div>
            ))}
        </div>
      )}
      {Array.isArray(d.actions) && d.actions.length > 0 && (
        <ol className="space-y-1">
          {d.actions.map((a: string, i: number) => (
            <li key={i} className="flex gap-1.5 text-[11px] text-gray-700">
              <span className="shrink-0 font-mono text-gray-400">{i + 1}.</span>
              {a}
            </li>
          ))}
        </ol>
      )}
      <WorkOrderButton
        seed={`Open a maintenance ticket for ${output.inverterId ?? 'this inverter'}: ${d.summary}`}
      />
    </RichToolCard>
  );
}
