'use client';

import { useState } from 'react';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Calculator, ChevronLeft, Info } from 'lucide-react';
import { type Region, getAllRegions, getRegionDisplayName, getDefaultInputs } from '@/data/roiCalculator';

interface ROICalculatorAdvancedProps {
  onCalculate: (inputs: {
    capacity: number;
    region: Region;
    currentEfficiency: number;
    soilingFrequency: number;
    omCosts: number;
    electricityRate: number;
  }) => void;
  onSwitchToSimple: () => void;
  isCalculating?: boolean;
}

export default function ROICalculatorAdvanced({
  onCalculate,
  onSwitchToSimple,
  isCalculating = false
}: ROICalculatorAdvancedProps) {
  const [capacity, setCapacity] = useState<number>(50);
  const [region, setRegion] = useState<Region>('uae');

  // Get defaults for selected region
  const defaults = getDefaultInputs(region);

  const [currentEfficiency, setCurrentEfficiency] = useState<number>(defaults.currentEfficiency);
  const [soilingFrequency, setSoilingFrequency] = useState<number>(defaults.soilingFrequency);
  const [omCosts, setOMCosts] = useState<number>(defaults.omCosts);
  const [electricityRate, setElectricityRate] = useState<number>(defaults.electricityRate);

  const regions = getAllRegions();

  // Update defaults when region changes
  const handleRegionChange = (newRegion: Region) => {
    setRegion(newRegion);
    const newDefaults = getDefaultInputs(newRegion);
    setCurrentEfficiency(newDefaults.currentEfficiency);
    setSoilingFrequency(newDefaults.soilingFrequency);
    setOMCosts(newDefaults.omCosts);
    setElectricityRate(newDefaults.electricityRate);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onCalculate({
      capacity,
      region,
      currentEfficiency,
      soilingFrequency,
      omCosts,
      electricityRate
    });
  };

  return (
    <div className="bg-paper rounded border-2 border-divider p-8">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-ink mb-2">
          Advanced ROI Calculator
        </h2>
        <p className="text-ink-2">
          Customize all parameters for a precise estimate
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
          <Select value={region} onValueChange={handleRegionChange}>
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

        {/* Current Efficiency */}
        <div>
          <Label htmlFor="efficiency" className="text-ink-2 font-semibold mb-3 flex items-center gap-2">
            Current Efficiency (Performance Ratio)
            <button
              type="button"
              className="text-primary hover:text-primary"
              title="Actual output / theoretical maximum output. Industry average: 85%"
            >
              <Info className="w-4 h-4" />
            </button>
          </Label>
          <div className="flex items-center gap-4">
            <Slider
              id="efficiency"
              min={50}
              max={100}
              step={1}
              value={[currentEfficiency]}
              onValueChange={(value) => setCurrentEfficiency(value[0])}
              className="flex-1"
            />
            <Input
              type="number"
              value={currentEfficiency}
              onChange={(e) => setCurrentEfficiency(parseFloat(e.target.value))}
              className="w-20 border-divider"
              min={50}
              max={100}
            />
            <span className="text-ink-2">%</span>
          </div>
        </div>

        {/* Soiling Frequency */}
        <div>
          <Label htmlFor="soiling" className="text-ink-2 font-semibold mb-3 flex items-center gap-2">
            Cleaning Frequency
            <button
              type="button"
              className="text-primary hover:text-primary"
              title="How often panels are currently cleaned per year"
            >
              <Info className="w-4 h-4" />
            </button>
          </Label>
          <div className="flex items-center gap-4">
            <Slider
              id="soiling"
              min={0}
              max={100}
              step={1}
              value={[soilingFrequency]}
              onValueChange={(value) => setSoilingFrequency(value[0])}
              className="flex-1"
            />
            <Input
              type="number"
              value={soilingFrequency}
              onChange={(e) => setSoilingFrequency(parseFloat(e.target.value))}
              className="w-20 border-divider"
              min={0}
              max={100}
            />
            <span className="text-ink-2">times/year</span>
          </div>
        </div>

        {/* O&M Costs */}
        <div>
          <Label htmlFor="omCosts" className="text-ink-2 font-semibold mb-3 flex items-center gap-2">
            Annual O&M Costs
            <button
              type="button"
              className="text-primary hover:text-primary"
              title="Current operations and maintenance spending per MW per year"
            >
              <Info className="w-4 h-4" />
            </button>
          </Label>
          <div className="flex items-center gap-2">
            <span className="text-ink-2">$</span>
            <Input
              id="omCosts"
              type="number"
              value={omCosts}
              onChange={(e) => setOMCosts(parseFloat(e.target.value))}
              className="flex-1 border-divider"
              min={0}
              step={1000}
            />
            <span className="text-ink-2">/ MW / year</span>
          </div>
        </div>

        {/* Electricity Rate */}
        <div>
          <Label htmlFor="electricityRate" className="text-ink-2 font-semibold mb-3 flex items-center gap-2">
            Electricity Rate
            <button
              type="button"
              className="text-primary hover:text-primary"
              title="PPA rate, feed-in tariff, or wholesale electricity price"
            >
              <Info className="w-4 h-4" />
            </button>
          </Label>
          <div className="flex items-center gap-2">
            <span className="text-ink-2">$</span>
            <Input
              id="electricityRate"
              type="number"
              value={electricityRate}
              onChange={(e) => setElectricityRate(parseFloat(e.target.value))}
              className="flex-1 border-divider"
              min={0}
              step={1}
            />
            <span className="text-ink-2">/ MWh</span>
          </div>
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
              Calculate Custom ROI
            </>
          )}
        </Button>

        {/* Simple Mode Link */}
        <button
          type="button"
          onClick={onSwitchToSimple}
          className="w-full text-primary hover:text-primary font-medium flex items-center justify-center gap-2 py-2 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          Switch to Simple Mode
        </button>
      </form>

      {/* Info Box */}
      <div className="mt-6 bg-paper-2 border border-divider rounded-lg p-4">
        <p className="text-sm text-ink-2">
          <span className="font-semibold">Advanced Mode</span> allows you to customize all parameters.
          Values are pre-filled with regional defaults. Hover over <Info className="w-3 h-3 inline" /> for parameter explanations.
        </p>
      </div>
    </div>
  );
}
