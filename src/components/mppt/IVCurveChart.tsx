'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface IVCurveChartProps {
  voltage_V: number;
  current_A: number;
  moduleCount: number;
  status: string;
}

/**
 * Renders an approximate I-V curve for a PV string based on the
 * measured operating point. The curve shape is derived from the
 * single-diode model approximation using the known Voc (open-circuit
 * voltage) and Isc (short-circuit current) estimated from the
 * operating point and module count.
 */
export default function IVCurveChart({
  voltage_V,
  current_A,
  moduleCount,
  status,
}: IVCurveChartProps) {
  const option = useMemo(() => {
    // Estimate Voc and Isc from operating point
    // Typical Voc ~ 37-40V per module, Isc ~ Imp * 1.1
    const vocPerModule = voltage_V / Math.max(moduleCount, 1) * 1.22;
    const voc = vocPerModule * moduleCount;
    const isc = current_A * 1.12;

    // Generate I-V curve points using simplified single-diode model
    const points = 80;
    const ivData: [number, number][] = [];
    const pvData: [number, number][] = [];

    for (let i = 0; i <= points; i++) {
      const v = (voc * i) / points;
      // Simplified diode equation: I = Isc * (1 - exp((V - Voc) / (Vt * n)))
      // Using thermal voltage approximation
      const vt = voc / 20; // thermal voltage scaling
      const current = isc * (1 - Math.exp((v - voc) / vt));
      const clampedCurrent = Math.max(0, current);
      ivData.push([parseFloat(v.toFixed(1)), parseFloat(clampedCurrent.toFixed(3))]);
      pvData.push([parseFloat(v.toFixed(1)), parseFloat((v * clampedCurrent).toFixed(2))]);
    }

    const isHealthy = status === 'normal';
    const curveColor = isHealthy ? '#3b82f6' : status === 'degraded' ? '#f59e0b' : '#ef4444';
    const powerColor = '#8b5cf6';

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          if (!params || !params.length) return '';
          const v = params[0].data[0];
          let html = `<strong>${v} V</strong><br/>`;
          params.forEach((p: any) => {
            const unit = p.seriesName === 'Current' ? ' A' : ' W';
            html += `${p.marker} ${p.seriesName}: ${p.data[1]}${unit}<br/>`;
          });
          return html;
        },
      },
      legend: {
        data: ['Current', 'Power'],
        bottom: 0,
        textStyle: { fontSize: 11, color: '#6b7280' },
      },
      grid: {
        left: 55,
        right: 55,
        top: 15,
        bottom: 40,
      },
      xAxis: {
        type: 'value',
        name: 'Voltage (V)',
        nameTextStyle: { color: '#6b7280', fontSize: 11 },
        axisLabel: { color: '#6b7280', fontSize: 10 },
        splitLine: { lineStyle: { color: '#f3f4f6' } },
        max: Math.ceil(voc * 1.05),
      },
      yAxis: [
        {
          type: 'value',
          name: 'Current (A)',
          nameTextStyle: { color: curveColor, fontSize: 11 },
          axisLabel: { color: '#6b7280', fontSize: 10 },
          splitLine: { lineStyle: { color: '#f3f4f6' } },
        },
        {
          type: 'value',
          name: 'Power (W)',
          nameTextStyle: { color: powerColor, fontSize: 11 },
          axisLabel: { color: '#6b7280', fontSize: 10 },
          splitLine: { show: false },
        },
      ],
      // Ensure legend markers match the actual line colours (default ECharts
      // palette would otherwise take precedence for the legend circles).
      color: [curveColor, powerColor, '#ef4444'],
      series: [
        {
          name: 'Current',
          type: 'line',
          data: ivData,
          smooth: true,
          symbol: 'none',
          itemStyle: { color: curveColor },
          lineStyle: { color: curveColor, width: 2.5 },
          yAxisIndex: 0,
        },
        {
          name: 'Power',
          type: 'line',
          data: pvData,
          smooth: true,
          symbol: 'none',
          itemStyle: { color: powerColor },
          lineStyle: { color: powerColor, width: 1.5, type: 'dashed' },
          yAxisIndex: 1,
        },
        {
          name: 'Operating Point',
          type: 'scatter',
          data: [[voltage_V, current_A]],
          symbolSize: 12,
          itemStyle: {
            color: '#ef4444',
            borderColor: '#fff',
            borderWidth: 2,
          },
          yAxisIndex: 0,
          tooltip: {
            formatter: () =>
              `<strong>Operating Point</strong><br/>Voltage: ${voltage_V} V<br/>Current: ${current_A} A<br/>Power: ${(voltage_V * current_A / 1000).toFixed(3)} kW`,
          },
        },
      ],
    };
  }, [voltage_V, current_A, moduleCount, status]);

  return (
    <ReactECharts
      option={option}
      style={{ height: 320, width: '100%' }}
      notMerge={true}
      lazyUpdate={true}
    />
  );
}
