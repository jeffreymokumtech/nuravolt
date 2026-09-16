import { InfoIcon, ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { LossComputationMetadata } from '@/types/faults';
import { useState } from 'react';

interface LossMethodologyPanelProps {
  metadata: LossComputationMetadata;
}

/**
 * Convert technical loss computation to plain language explanation.
 *
 * This function transforms complex formulas and technical factors into
 * clear, user-friendly explanations that operators can understand.
 */
function getPlainLanguageExplanation(metadata: LossComputationMetadata): string {
  const { method, factors } = metadata;

  if (method !== 'reactive_factor') {
    return 'Energy loss calculated using advanced modeling techniques.';
  }

  // String open circuit
  if (factors.affected_strings === 1 && factors.n_strings && factors.per_string_capacity_kw) {
    return `One string out of ${factors.n_strings} is not producing power. Each string normally contributes ${factors.per_string_capacity_kw.toFixed(2)} kW. Since this string has been offline for ${factors.duration_hours?.toFixed(1) || '0'} hours, the total energy loss is ${(factors.per_string_capacity_kw * (factors.duration_hours || 0)).toFixed(0)} kWh.`;
  }

  // Inverter offline
  if (factors.loss_factor_pct === 100 && factors.rated_ac_power_kw) {
    return `This inverter is completely offline and producing no power. The inverter is rated for ${factors.rated_ac_power_kw} kW. It has been offline for ${factors.duration_hours?.toFixed(1) || '0'} hours, resulting in ${(factors.rated_ac_power_kw * (factors.duration_hours || 0)).toFixed(0)} kWh of lost energy.`;
  }

  // Thermal derating
  if (factors.loss_factor_pct === 50 && factors.rated_ac_power_kw) {
    return `High temperatures are causing the inverter to reduce its output to protect itself. At ${factors.duration_hours?.toFixed(1) || '0'} hours of reduced operation at 50% capacity, this has cost ${(factors.rated_ac_power_kw * 0.5 * (factors.duration_hours || 0)).toFixed(0)} kWh of energy production.`;
  }

  // Tracker stuck
  if (factors.rationale?.includes('tracker') || factors.rationale?.includes('tracking')) {
    return `The tracker is stuck at a fixed angle instead of following the sun. This reduces energy capture by approximately ${factors.loss_factor_pct}% throughout the day. Over ${factors.duration_hours?.toFixed(1) || '0'} hours, this has resulted in ${((factors.rated_ac_power_kw || 0) * (factors.loss_factor_pct || 0) / 100 * (factors.duration_hours || 0)).toFixed(0)} kWh of lost energy.`;
  }

  // Clipping
  if (factors.rationale?.includes('clipping') || factors.rationale?.includes('AC output limited')) {
    return `The inverter is at its maximum capacity, so extra DC power from the panels cannot be converted. This happens during peak sun hours and has caused ${((factors.rated_ac_power_kw || 0) * (factors.loss_factor_pct || 0) / 100 * (factors.duration_hours || 0)).toFixed(0)} kWh of lost energy over ${factors.duration_hours?.toFixed(1) || '0'} hours.`;
  }

  // Generic loss
  if (factors.rated_ac_power_kw && factors.loss_factor_pct && factors.duration_hours) {
    return `Equipment is operating at ${100 - factors.loss_factor_pct}% of expected capacity. This has resulted in ${(factors.rated_ac_power_kw * factors.loss_factor_pct / 100 * factors.duration_hours).toFixed(0)} kWh of lost energy over ${factors.duration_hours.toFixed(1)} hours.`;
  }

  return 'Energy loss calculated based on equipment capacity and fault duration.';
}

export function LossMethodologyPanel({ metadata }: LossMethodologyPanelProps) {
  const [showTechnical, setShowTechnical] = useState(false);
  const methodLabels: Record<string, string> = {
    reactive_factor: 'Reactive Loss Factor',
    physics_model: 'Physics-Based Model',
    digital_twin: 'Digital Twin Residual',
    rul_prediction: 'RUL Predictive Model'
  };

  return (
    <Card className="mt-4 border-blue-200 dark:border-blue-800">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <InfoIcon className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          How Energy Loss is Calculated
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {/* Plain Language Explanation */}
        <div className="text-sm leading-relaxed text-gray-700 dark:text-gray-300">
          {getPlainLanguageExplanation(metadata)}
        </div>

        {/* Collapsible Technical Details */}
        <button
          onClick={() => setShowTechnical(!showTechnical)}
          className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 underline transition-colors"
        >
          {showTechnical ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          Technical Details
        </button>

        {showTechnical && (
          <div className="space-y-3 p-3 bg-slate-50 dark:bg-slate-900 rounded border">
            {/* Method Badge */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium">Method:</span>
              <Badge variant="outline" className="text-xs">
                {methodLabels[metadata.method] || metadata.method}
              </Badge>
            </div>

            {/* Power Loss Formula */}
            <div>
              <span className="text-xs font-medium text-muted-foreground">Power Loss Formula:</span>
              <code className="block mt-1.5 text-xs bg-white dark:bg-slate-800 px-3 py-2 rounded border font-mono overflow-x-auto">
                {metadata.power_formula}
              </code>
            </div>

            {/* Energy Loss Formula */}
            <div>
              <span className="text-xs font-medium text-muted-foreground">Energy Loss Formula:</span>
              <code className="block mt-1.5 text-xs bg-white dark:bg-slate-800 px-3 py-2 rounded border font-mono overflow-x-auto">
                {metadata.energy_formula}
              </code>
            </div>

            {/* Contributing Factors */}
            <div>
              <span className="text-xs font-medium text-muted-foreground">Contributing Factors:</span>
              <div className="mt-2 space-y-1.5">
                {Object.entries(metadata.factors).map(([key, value]) => {
                  if (key === 'rationale') {
                    return (
                      <div key={key} className="text-xs bg-blue-50 dark:bg-blue-950 px-3 py-2 rounded border border-blue-200 dark:border-blue-800 mt-2">
                        <strong className="text-blue-700 dark:text-blue-300">Basis:</strong>{' '}
                        <span className="text-blue-900 dark:text-blue-100">{value}</span>
                      </div>
                    );
                  }
                  return (
                    <div key={key} className="flex justify-between items-center text-xs">
                      <span className="text-muted-foreground capitalize">
                        {key.replace(/_/g, ' ')}:
                      </span>
                      <span className="font-mono font-medium">
                        {typeof value === 'number' ? value.toFixed(2) : value}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Reference */}
            {metadata.reference && (
              <div className="pt-2 border-t">
                <span className="text-xs text-muted-foreground">
                  <strong>Reference:</strong> {metadata.reference}
                </span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
