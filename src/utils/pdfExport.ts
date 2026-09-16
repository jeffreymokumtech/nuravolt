import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import { format } from 'date-fns';
import type { LiveCostBenefitResult, CleaningParameters } from '@/types/soiling';


export interface ExportOptions {
  plantId: string;
  plantName?: string;
  cleaningDates: string[];
  parameters: CleaningParameters;
  result: LiveCostBenefitResult;
  includeCharts?: boolean;
  includeParameters?: boolean;
}

export async function exportToPDF(options: ExportOptions): Promise<void> {
  const {
    plantId,
    plantName = plantId,
    cleaningDates,
    parameters,
    result,
    includeCharts = true,
    includeParameters = true,
  } = options;

  // Create PDF
  const pdf = new jsPDF('p', 'mm', 'a4');
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 15;
  let yPos = margin;

  // Header
  pdf.setFontSize(20);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Cleaning Schedule Report', margin, yPos);
  yPos += 8;

  pdf.setFontSize(12);
  pdf.setFont('helvetica', 'normal');
  pdf.text(`Plant: ${plantName}`, margin, yPos);
  yPos += 6;

  pdf.setFontSize(10);
  pdf.setTextColor(100);
  pdf.text(`Generated: ${format(new Date(), 'MMM d, yyyy HH:mm')}`, margin, yPos);
  pdf.setTextColor(0);
  yPos += 10;

  // Summary Box
  pdf.setFillColor(240, 253, 244); // Light green
  pdf.rect(margin, yPos, pageWidth - 2 * margin, 40, 'F');

  pdf.setFontSize(14);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Summary', margin + 5, yPos + 8);

  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'normal');
  yPos += 15;

  const summaryData = [
    ['Cleanings Scheduled', `${cleaningDates.length}x`],
    ['Net Benefit', `€${Math.round(result.estimated_net_benefit_EUR).toLocaleString()}`],
    [
      'ROI',
      `${result.estimated_roi_pct >= 0 ? result.estimated_roi_pct.toFixed(1) : 'N/A'}%`,
    ],
    ['Avg Soiling Ratio', `${(result.estimated_avg_sr * 100).toFixed(1)}%`],
  ];

  summaryData.forEach(([label, value], index) => {
    const col1X = margin + 5;
    const col2X = margin + 60;
    const col3X = margin + 100;
    const col4X = margin + 155;

    if (index % 2 === 0) {
      pdf.text(label, col1X, yPos);
      pdf.setFont('helvetica', 'bold');
      pdf.text(value, col2X, yPos);
      pdf.setFont('helvetica', 'normal');
    } else {
      pdf.text(label, col3X, yPos);
      pdf.setFont('helvetica', 'bold');
      pdf.text(value, col4X, yPos);
      pdf.setFont('helvetica', 'normal');
    }

    if (index % 2 === 1) {
      yPos += 6;
    }
  });

  yPos += 10;

  // Cleaning Dates
  pdf.setFontSize(12);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Scheduled Cleaning Dates', margin, yPos);
  yPos += 8;

  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'normal');

  if (cleaningDates.length > 0) {
    const datesPerRow = 3;
    cleaningDates.forEach((date, index) => {
      const colIndex = index % datesPerRow;
      const colX = margin + colIndex * 60;

      if (colIndex === 0 && index > 0) {
        yPos += 6;
      }

      pdf.text(`• ${format(new Date(date), 'MMM d, yyyy')}`, colX, yPos);
    });
    yPos += 8;
  } else {
    pdf.text('No cleaning dates scheduled', margin, yPos);
    yPos += 8;
  }

  // Parameters (if included)
  if (includeParameters) {
    yPos += 5;
    pdf.setFontSize(12);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Parameters', margin, yPos);
    yPos += 8;

    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'normal');

    const paramData = [
      ['Capacity', `${parameters.capacity_MW} MW`],
      ['Cleaning Cost', `€${parameters.cleaning_cost_per_MW}/MW`],
      ['Electricity Rate', `€${parameters.electricity_rate_per_MWh}/MWh`],
      ['Min Days Between', `${parameters.min_days_between_cleanings} days`],
      ['Rain Threshold', `${parameters.rain_threshold_mm} mm`],
      ['SR Threshold', `${(parameters.cleaning_threshold_sr * 100).toFixed(0)}%`],
    ];

    paramData.forEach(([label, value], index) => {
      const col1X = margin;
      const col2X = margin + 60;
      const col3X = margin + 100;
      const col4X = margin + 160;

      if (index % 2 === 0) {
        pdf.text(label + ':', col1X, yPos);
        pdf.text(value, col2X, yPos);
      } else {
        pdf.text(label + ':', col3X, yPos);
        pdf.text(value, col4X, yPos);
      }

      if (index % 2 === 1) {
        yPos += 5;
      }
    });

    yPos += 5;
  }

  // Financial Breakdown
  yPos += 5;
  pdf.setFontSize(12);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Financial Breakdown', margin, yPos);
  yPos += 8;

  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'normal');

  const financialData = [
    ['Energy Recovered', `${result.estimated_energy_recovered_MWh.toFixed(1)} MWh`],
    [
      'Revenue Recovered',
      `€${Math.round(result.estimated_revenue_recovered_EUR).toLocaleString()}`,
    ],
    ['Total Cleaning Cost', `€${Math.round(result.total_cost_EUR).toLocaleString()}`],
    ['Net Benefit', `€${Math.round(result.estimated_net_benefit_EUR).toLocaleString()}`],
  ];

  financialData.forEach(([label, value]) => {
    pdf.text(label + ':', margin, yPos);
    pdf.setFont('helvetica', 'bold');
    pdf.text(value, margin + 60, yPos);
    pdf.setFont('helvetica', 'normal');
    yPos += 6;
  });

  // Charts (if included)
  if (includeCharts) {
    pdf.addPage();
    yPos = margin;

    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Visualizations', margin, yPos);
    yPos += 10;

    try {
      // Capture timeline
      const timelineElement = document.querySelector(
        '[data-export="cleaning-timeline"]'
      ) as HTMLElement;
      if (timelineElement) {
        const timelineCanvas = await html2canvas(timelineElement, {
          scale: 2,
          logging: false,
          backgroundColor: '#ffffff',
        });

        const timelineImgData = timelineCanvas.toDataURL('image/png');
        const timelineWidth = pageWidth - 2 * margin;
        const timelineHeight = (timelineCanvas.height * timelineWidth) / timelineCanvas.width;

        pdf.setFontSize(11);
        pdf.setFont('helvetica', 'bold');
        pdf.text('Cleaning Schedule Timeline', margin, yPos);
        yPos += 8;

        pdf.addImage(timelineImgData, 'PNG', margin, yPos, timelineWidth, timelineHeight);
        yPos += timelineHeight + 10;
      }

      // Capture charts
      const chartsElement = document.querySelector('[data-export="charts"]') as HTMLElement;
      if (chartsElement && yPos + 80 < pageHeight) {
        const chartsCanvas = await html2canvas(chartsElement, {
          scale: 2,
          logging: false,
          backgroundColor: '#ffffff',
        });

        const chartsImgData = chartsCanvas.toDataURL('image/png');
        const chartsWidth = pageWidth - 2 * margin;
        const chartsHeight = (chartsCanvas.height * chartsWidth) / chartsCanvas.width;

        // Add new page if needed
        if (yPos + chartsHeight > pageHeight - margin) {
          pdf.addPage();
          yPos = margin;
        }

        pdf.setFontSize(11);
        pdf.setFont('helvetica', 'bold');
        pdf.text('Cost/Benefit Analysis Charts', margin, yPos);
        yPos += 8;

        pdf.addImage(chartsImgData, 'PNG', margin, yPos, chartsWidth, chartsHeight);
      }
    } catch (error) {
      console.error('Error capturing charts:', error);
      pdf.setFontSize(10);
      pdf.setTextColor(200, 0, 0);
      pdf.text('Unable to capture charts. Please try again.', margin, yPos);
      pdf.setTextColor(0);
    }
  }

  // Footer on last page
  const totalPages = pdf.internal.pages.length - 1;
  for (let i = 1; i <= totalPages; i++) {
    pdf.setPage(i);
    pdf.setFontSize(8);
    pdf.setTextColor(150);
    pdf.text(
      `Generated by NuraVolt • Page ${i} of ${totalPages}`,
      pageWidth / 2,
      pageHeight - 10,
      { align: 'center' }
    );
    pdf.setTextColor(0);
  }

  // Save PDF
  const filename = `cleaning-schedule-${plantId}-${format(new Date(), 'yyyy-MM-dd')}.pdf`;
  pdf.save(filename);
}
