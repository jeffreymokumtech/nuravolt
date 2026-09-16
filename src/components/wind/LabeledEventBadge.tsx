/**
 * LabeledEventBadge - Visual indicator for ground-truth vs ML-detected faults
 *
 * Features:
 * - Distinct styling for LABELED (ground-truth) vs DETECTED
 * - Tooltip with CARE metadata
 * - Lead time indicator for early detections
 */

'use client';

import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { CheckCircle, Cpu, Clock, Database } from 'lucide-react';
import type { FaultSource, DetectionMethod, CAREMetadata } from '@/types/wind';

interface LabeledEventBadgeProps {
  source: FaultSource;
  leadTimeDays?: number;
  detectionMethod?: DetectionMethod;
  careMetadata?: CAREMetadata;
  showTooltip?: boolean;
  size?: 'sm' | 'default';
}

const DETECTION_METHOD_LABELS: Record<DetectionMethod, string> = {
  NBM: 'Normal Behavior Model',
  POWER_CURVE: 'Power Curve Analysis',
  THRESHOLD: 'Threshold Monitoring',
  ANOMALY_DETECTION: 'Anomaly Detection',
};

export function LabeledEventBadge({
  source,
  leadTimeDays,
  detectionMethod,
  careMetadata,
  showTooltip = true,
  size = 'default',
}: LabeledEventBadgeProps) {
  const isLabeled = source === 'LABELED';

  const badge = (
    <Badge
      variant={isLabeled ? 'secondary' : 'outline'}
      className={`${
        isLabeled
          ? 'bg-purple-100 text-purple-700 border-purple-200'
          : 'bg-blue-50 text-blue-700 border-blue-200'
      } ${size === 'sm' ? 'text-xs px-1.5 py-0' : ''}`}
    >
      {isLabeled ? (
        <>
          <CheckCircle className={`${size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} mr-1`} />
          Ground Truth
        </>
      ) : (
        <>
          <Cpu className={`${size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} mr-1`} />
          ML Detected
        </>
      )}
    </Badge>
  );

  if (!showTooltip) return badge;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {isLabeled ? (
            <div className="space-y-2">
              <p className="font-semibold text-purple-700">
                Ground Truth Event
              </p>
              <p className="text-xs text-muted-foreground">
                This fault is a verified event from the CARE dataset with
                labeled failure information.
              </p>
              {careMetadata && (
                <div className="pt-2 border-t space-y-1">
                  <p className="text-xs flex items-center gap-1">
                    <Database className="h-3 w-3" />
                    Farm {careMetadata.farm} | {careMetadata.features} SCADA
                    features
                  </p>
                  <p className="text-xs flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Duration: {careMetadata.durationDays} days
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="font-semibold text-blue-700">ML-Detected Anomaly</p>
              <p className="text-xs text-muted-foreground">
                This fault was automatically detected by our predictive
                maintenance models.
              </p>
              {detectionMethod && (
                <p className="text-xs">
                  Method: {DETECTION_METHOD_LABELS[detectionMethod]}
                </p>
              )}
              {leadTimeDays !== undefined && leadTimeDays > 0 && (
                <p className="text-xs font-medium text-green-600">
                  Detected {leadTimeDays} days before failure
                </p>
              )}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * LeadTimeBadge - Shows how early a fault was detected
 */
interface LeadTimeBadgeProps {
  days: number;
  size?: 'sm' | 'default';
}

export function LeadTimeBadge({ days, size = 'default' }: LeadTimeBadgeProps) {
  if (days <= 0) return null;

  const getColor = () => {
    if (days >= 14) return 'bg-green-100 text-green-700 border-green-200';
    if (days >= 7) return 'bg-lime-100 text-lime-700 border-lime-200';
    if (days >= 3) return 'bg-yellow-100 text-yellow-700 border-yellow-200';
    return 'bg-orange-100 text-orange-700 border-orange-200';
  };

  const formatDays = () => {
    if (days === 1) return '1 day early';
    if (days < 7) return `${days} days early`;
    if (days < 14) return `${Math.round(days / 7)} week early`;
    if (days < 30) return `${Math.round(days / 7)} weeks early`;
    return `${Math.round(days / 30)} month${days >= 60 ? 's' : ''} early`;
  };

  return (
    <Badge
      variant="outline"
      className={`${getColor()} ${size === 'sm' ? 'text-xs px-1.5 py-0' : ''}`}
    >
      <Clock className={`${size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} mr-1`} />
      {formatDays()}
    </Badge>
  );
}

export default LabeledEventBadge;
