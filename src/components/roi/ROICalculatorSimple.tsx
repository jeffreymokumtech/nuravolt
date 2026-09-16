'use client';

import { useState } from 'react';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Calculator, ChevronRight } from 'lucide-react';
import { type Region, getAllRegions, getRegionDisplayName } from '@/data/roiCalculator';

interface ROICalculatorSimpleProps {
  onCalculate: (capacity: number, region: Region) => void;
  onSwitchToAdvanced: () => void;
  isCalculating?: boolean;
}

export default function ROICalculatorSimple({
  onCalculate,
  onSwitchToAdvanced,
  isCalculating = false
}: ROICalculatorSimpleProps) {
  const [capacity, setCapacity] = useState<number>(50);
  const [region, setRegion] = useState<Region>('uae');

  const regions = getAllRegions();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onCalculate(capacity, region);
  };

  return (
    <div className="bg-paper rounded border-2 border-divider p-8">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-ink mb-2">
          Quick ROI Estimate
        </h2>
        <p className="text-ink-2">
          Get instant cost savings estimate for your solar plant
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Plant Capacity Slider */}
        <div>
          <Label htmlFor="capacity" className="text-ink-2 font-semibold mb-3 block">
            Plant Capacity: <span className="text-primary">{capacity} MW</span>
          </Label>
          <Slider
            id="capacity"
            min={10}
            max={500}
            step={5}
            value={[capacity]}
            onValueChange={(value) => setCapacity(value[0])}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-ink-3 mt-2">
            <span>10 MW</span>
            <span>500 MW</span>
          </div>
        </div>

        {/* Region Select */}
        <div>
          <Label htmlFor="region" className="text-ink-2 font-semibold mb-3 block">
            Region
          </Label>
          <Select value={region} onValueChange={(value) => setRegion(value as Region)}>
            <SelectTrigger className="w-full border-divider focus:border-divider focus:ring-ring">
              <SelectValue placeholder="Select region" />
            </SelectTrigger>
            <SelectContent>
              {regions.map((r) => (
                <SelectItem key={r} value={r}>
                  {getRegionDisplayName(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Calculate Button */}
        <Button
          type="submit"
          disabled={isCalculating}
          className="w-full bg-primary hover:bg-primary text-white py-4 rounded-lg font-semibold transition-colors text-lg"
        >
          {isCalculating ? (
            <>
              <Calculator className="w-5 h-5 mr-2 animate-pulse" />
              Calculating...
            </>
          ) : (
            <>
              <Calculator className="w-5 h-5 mr-2" />
              Calculate ROI
            </>
          )}
        </Button>

        {/* Advanced Mode Link */}
        <button
          type="button"
          onClick={onSwitchToAdvanced}
          className="w-full text-primary hover:text-primary font-medium flex items-center justify-center gap-2 py-2 transition-colors"
        >
          Need more control? Use Advanced Mode
          <ChevronRight className="w-4 h-4" />
        </button>
      </form>

      {/* Info Box */}
      <div className="mt-6 bg-paper-2 border border-divider rounded-lg p-4">
        <p className="text-sm text-ink-2">
          <span className="font-semibold">Simple Mode</span> uses industry-standard assumptions based on your region.
          Switch to Advanced Mode to customize efficiency, cleaning frequency, and O&M costs.
        </p>
      </div>
    </div>
  );
}
