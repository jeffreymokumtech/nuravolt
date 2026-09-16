'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useDataRoot } from '@/contexts/DataSourceContext';

/**
 * Audit bundle loader, API-first: live artifacts from
 * `/api/bess/plants/[plantId]/audit` (written weekly by the bess-audit job,
 * provenance-tagged modelled twin) with the committed static specimen JSON
 * as the fallback for fixture-only demo plants. Both carry the identical
 * dossier/audit dict shape (types.ts), so sections render either unchanged.
 */

export interface AuditProvenance {
  telemetry_source?: string;
  provisional?: boolean;
  price_source?: string;
  asset_id?: string;
  days?: number;
  framing?: string;
}

const API_FILE: Record<string, string> = {
  'optimizer_audit.json': 'optimizer',
  'warranty_dossier.json': 'dossier',
};

export function useAuditJson<T>(file: 'optimizer_audit.json' | 'warranty_dossier.json') {
  const dataRoot = useDataRoot();
  const params = useParams();
  const plantId = params.plantId as string;

  const [data, setData] = useState<T | null>(null);
  const [provenance, setProvenance] = useState<AuditProvenance | null>(null);
  const [source, setSource] = useState<'database' | 'specimen' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setProvenance(null);
    setSource(null);

    (async () => {
      try {
        // Live artifact first.
        const live = await fetch(`/api/bess/plants/${plantId}/audit?file=${API_FILE[file]}`).catch(
          (): null => null,
        );
        if (live?.ok) {
          const json = await live.json();
          if (!cancelled) {
            setData(json as T);
            setProvenance((json.provenance as AuditProvenance) ?? null);
            setSource('database');
          }
          return;
        }

        // Static specimen fallback (fixture-only demo plants).
        const res = await fetch(`${dataRoot}/audit/${plantId}/${file}`);
        if (!res.ok) throw new Error(`No audit bundle for this plant (${res.status})`);
        const json = await res.json();
        if (!cancelled) {
          setData(json as T);
          setProvenance((json.provenance as AuditProvenance) ?? null);
          setSource('specimen');
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load audit data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [dataRoot, plantId, file]);

  return { data, provenance, source, loading, error };
}

