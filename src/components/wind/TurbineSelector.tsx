/**
 * TurbineSelector - Dropdown to select a specific turbine or fleet view
 */

'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Wind } from 'lucide-react';
import type { WindTurbine, TurbineHealthSummary } from '@/types/wind';
import { getHealthColor } from '@/types/wind';

interface TurbineWithHealth extends WindTurbine {
  health: TurbineHealthSummary | null;
}

interface TurbineSelectorProps {
  turbines: TurbineWithHealth[];
  selectedId: string | null;
  onSelect: (turbineId: string | null) => void;
  showHealth?: boolean;
}

export function TurbineSelector({
  turbines,
  selectedId,
  onSelect,
  showHealth = true,
}: TurbineSelectorProps) {
  return (
    <Select
      value={selectedId || 'FLEET'}
      onValueChange={(value) => onSelect(value === 'FLEET' ? null : value)}
    >
      <SelectTrigger className="w-48">
        <div className="flex items-center gap-2">
          <Wind className="h-4 w-4" />
          <SelectValue placeholder="Select turbine" />
        </div>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="FLEET">
          <div className="flex items-center gap-2">
            <span className="font-medium">Fleet Overview</span>
            <span className="text-xs text-muted-foreground">
              ({turbines.length} turbines)
            </span>
          </div>
        </SelectItem>
        <div className="my-1 border-t" />
        {turbines.map((turbine) => {
          const health = turbine.health?.overallHealth;
          const healthColor = health ? getHealthColor(health) : undefined;

          return (
            <SelectItem key={turbine.id} value={turbine.id}>
              <div className="flex items-center justify-between w-full gap-4">
                <span>{turbine.name}</span>
                {showHealth && health !== undefined && (
                  <span
                    className="text-xs font-medium"
                    style={{ color: healthColor }}
                  >
                    {health}%
                  </span>
                )}
              </div>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

export default TurbineSelector;
