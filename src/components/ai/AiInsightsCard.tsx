'use client';

import { useState, useEffect } from 'react';
import { Sparkles, RefreshCw, AlertCircle } from 'lucide-react';
import OpsPanel from '@/components/ops/OpsPanel';
import LiveBadge from '@/components/ops/LiveBadge';

interface PlantData {
  plantName?: string;
  capacity_MW?: number;
  fleetSoiling?: {
    srMean: number;
    srMin: number;
    srMax: number;
  };
  fleetLosses?: {
    totalSoilingLoss_MWh: number;
    totalLoss_MWh: number;
  };
  healthDistribution?: {
    normal: number;
    minorIssues: number;
    majorIssues: number;
    critical: number;
  };
  economicImpact?: {
    estimatedAnnualLoss_EUR: number;
    cleaningROIPotential_EUR: number;
  };
}

interface AiInsightsCardProps {
  plantId: string;
  plantData: PlantData;
}

/**
 * AI insights panel, calls Bedrock via the existing /api/llm/insights
 * endpoint and renders the response inside an OpsPanel. The previous
 * violet-gradient SaaS card is replaced by the ops chrome; the Bedrock
 * call + auto-refresh on mount + manual refresh button are preserved.
 */
export default function AiInsightsCard({ plantId, plantData }: AiInsightsCardProps) {
  const [insights, setInsights] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateInsights = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/llm/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plantId, plantData }),
      });

      const data = await response.json();

      if (!response.ok) {
        // Plan gate (402): show the upgrade path, not a raw error code.
        if (data.error === 'plan_upgrade_required') {
          throw new Error('AI insights are available on the Business plan — see /pricing to upgrade.');
        }
        throw new Error(data.error || 'Failed to generate insights');
      }

      setInsights(data.insights);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (plantId && !insights && !loading) {
      generateInsights();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plantId]);

  return (
    <OpsPanel
      label={
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5" style={{ color: 'var(--ops-bess)' }} />
          AI intelligence
        </span>
      }
      meta={
        <span className="inline-flex items-center gap-3">
          <LiveBadge label={loading ? 'Analysing' : 'Live'} tone={loading ? 'warn' : 'info'} />
          <button
            type="button"
            onClick={generateInsights}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] transition-colors disabled:opacity-40"
            style={{
              color: 'var(--ops-info)',
              background: 'var(--ops-ack-bg)',
              border: '1px solid var(--ops-ack-border)',
            }}
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'analysing' : 'refresh'}
          </button>
        </span>
      }
    >
      {error && (
        <div
          className="flex items-start gap-2 rounded-md border p-2 font-mono text-[11px]"
          style={{
            color: 'var(--ops-alarm)',
            background: 'var(--ops-alarm-bg)',
            borderColor: 'var(--ops-alarm-border)',
          }}
        >
          <AlertCircle className="mt-px h-3.5 w-3.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && !insights && (
        <div className="flex flex-col gap-2">
          <div
            className="h-3 w-3/4 animate-pulse rounded"
            style={{ background: 'var(--ops-row-hair)' }}
          />
          <div
            className="h-3 w-1/2 animate-pulse rounded"
            style={{ background: 'var(--ops-row-hair)' }}
          />
          <div
            className="h-3 w-5/6 animate-pulse rounded"
            style={{ background: 'var(--ops-row-hair)' }}
          />
        </div>
      )}

      {insights && (
        <div
          className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed"
          style={{ color: 'var(--ops-txt)' }}
        >
          {insights}
        </div>
      )}
    </OpsPanel>
  );
}
