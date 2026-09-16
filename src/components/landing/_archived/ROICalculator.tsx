'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';

interface ROIData {
  currentGeneration: number;
  powerLossKwh: number;
  financialLossAED: number;
  potentialSavingsAED: number;
  paybackMonths: number;
}

const ROICalculator = () => {
  const [plantCapacityMw, setPlantCapacityMw] = useState<number>(10);
  const [currentEfficiency, setCurrentEfficiency] = useState<number>(75);
  const [electricityRateAED, setElectricityRateAED] = useState<number>(0.29);
  const [roiData, setRoiData] = useState<ROIData | null>(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const { t } = useLanguage();

  const OPTIMAL_EFFICIENCY = 0.85;
  const UAE_SOLAR_HOURS = 2200;
  const IMPROVEMENT_FACTOR = 0.15;

  const calculateROI = () => {
    setIsCalculating(true);
    
    const currentGeneration = plantCapacityMw * 1000 * UAE_SOLAR_HOURS * (currentEfficiency / 100);
    const optimalGeneration = plantCapacityMw * 1000 * UAE_SOLAR_HOURS * OPTIMAL_EFFICIENCY;
    const powerLossKwh = optimalGeneration - currentGeneration;
    const financialLossAED = powerLossKwh * electricityRateAED;
    const potentialSavingsAED = financialLossAED * IMPROVEMENT_FACTOR;
    
    const monthlyRevenue = (plantCapacityMw * 1000 * UAE_SOLAR_HOURS * electricityRateAED) / 12;
    const monthlySavings = potentialSavingsAED / 12;
    const subscriptionCost = plantCapacityMw <= 50 ? 999 : 2999;
    const paybackMonths = subscriptionCost / monthlySavings;

    setRoiData({
      currentGeneration,
      powerLossKwh,
      financialLossAED,
      potentialSavingsAED,
      paybackMonths
    });
    
    setIsCalculating(false);
  };

  useEffect(() => {
    calculateROI();
  }, [plantCapacityMw, currentEfficiency, electricityRateAED]);

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat('en-US', {
      maximumFractionDigits: 0
    }).format(num);
  };

  const formatCurrency = (num: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'AED',
      maximumFractionDigits: 0
    }).format(num);
  };

  return (
    <Card className="w-full max-w-2xl mx-auto">
      <CardHeader>
        <CardTitle className="text-2xl font-bold text-center">
          {t('roi.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="capacity">{t('roi.plantCapacity')}</Label>
            <Input
              id="capacity"
              type="number"
              value={plantCapacityMw}
              onChange={(e) => setPlantCapacityMw(Number(e.target.value))}
              min="1"
              max="1000"
              step="1"
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="efficiency">{t('roi.currentEfficiency')}</Label>
            <Input
              id="efficiency"
              type="number"
              value={currentEfficiency}
              onChange={(e) => setCurrentEfficiency(Number(e.target.value))}
              min="50"
              max="100"
              step="1"
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="rate">{t('roi.electricityRate')}</Label>
            <Input
              id="rate"
              type="number"
              value={electricityRateAED}
              onChange={(e) => setElectricityRateAED(Number(e.target.value))}
              min="0.1"
              max="1"
              step="0.01"
            />
          </div>
        </div>

        {roiData && (
          <div className="pt-6 border-t">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div>
                  <p className="text-sm text-gray-600">{t('roi.annualPowerLoss')}</p>
                  <p className="text-2xl font-bold text-blue-700">
                    {formatNumber(roiData.powerLossKwh)} kWh
                  </p>
                </div>
                
                <div>
                  <p className="text-sm text-gray-600">{t('roi.annualRevenueLoss')}</p>
                  <p className="text-2xl font-bold text-blue-700">
                    {formatCurrency(roiData.financialLossAED)}
                  </p>
                </div>
              </div>
              
              <div className="space-y-4">
                <div>
                  <p className="text-sm text-gray-600">{t('roi.potentialSavings')}</p>
                  <p className="text-2xl font-bold text-blue-500">
                    {formatCurrency(roiData.potentialSavingsAED)}
                  </p>
                </div>
                
                <div>
                  <p className="text-sm text-gray-600">{t('roi.timeline')}</p>
                  <p className="text-2xl font-bold text-blue-600">
                    {roiData.paybackMonths.toFixed(1)} {t('roi.months')}
                  </p>
                </div>
              </div>
            </div>
            
            <div className="mt-6 p-4 bg-blue-50 rounded-lg">
              <p className="text-sm text-blue-900">
                With HeliosIQ's AI-powered optimization, you could recover{' '}
                <span className="font-bold">{formatCurrency(roiData.potentialSavingsAED)}</span>{' '}
                annually by improving your plant efficiency by 15%.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default ROICalculator;