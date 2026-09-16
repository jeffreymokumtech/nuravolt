import { jsPDF } from 'jspdf';
import type { BessReportData } from './bessReportData';

// ============================================================
// Portfolio Report PDF Types
// ============================================================

export interface ReportPlant {
  plantName: string;
  location: string;
  capacity_MW: number;
  healthScore: number | null;
  riskScore: number;
  riskLevel: string;
  revenueAtRisk: number;
  budgetDeviation: number;
  soilingLoss: number;
  faultLoss: number;
  availability: number;
  performanceRatio: number;
}

export interface CompliancePlantSummary {
  plantName: string;
  country: string;
  packVersion: string;
  regulator: string;
  gridOperator: string;
  gridCodeReference: string;
  meterClass: string;
  obligations: {
    name: string;
    recipient: string;
    cadence: string;
    deadlineDays: number;
  }[];
}

export interface ContractObligationRow {
  plantName: string;
  contractType: string;
  field: string;
  status: string; // ok | at_risk | breach | no_data | unmonitored
  observed: string;
  threshold: string;
}

export interface ReportData {
  reportName: string;
  period: string;
  generatedAt: string;
  summary: {
    totalPlants: number;
    totalCapacity_MW: number;
    totalRevenue: number;
    totalRevenueAtRisk: number;
    budgetDeviation: number;
    riskScore: number;
    riskLevel: string;
    totalSoilingLoss: number;
    totalFaultLoss: number;
  };
  plants: ReportPlant[];
  includeSummary: boolean;
  includeRisk: boolean;
  includeLosses: boolean;
  /** Which sections to render. If empty/undefined, falls back to boolean flags. */
  sections?: string[];
  /** BESS asset data for battery sections. */
  bessData?: BessReportData[];
  /** Country-specific compliance obligations per plant, rendered as a checklist. */
  complianceSummaries?: CompliancePlantSummary[];
  /** Live contract-obligation statuses (org/db mode only). */
  contractRows?: ContractObligationRow[];
}

// ============================================================
// Color constants
// ============================================================

type RGB = [number, number, number];

const COLORS = {
  headerBg: [30, 64, 175] as RGB,        // #1e40af blue-800
  headerText: [255, 255, 255] as RGB,
  tableHeaderBg: [241, 245, 249] as RGB,  // #f1f5f9 slate-100
  tableRowAlt: [248, 250, 252] as RGB,    // #f8fafc slate-50
  textPrimary: [15, 23, 42] as RGB,       // slate-900
  textSecondary: [100, 116, 139] as RGB,  // slate-500
  borderLight: [226, 232, 240] as RGB,    // slate-200
  green: [22, 163, 74] as RGB,
  red: [220, 38, 38] as RGB,
  amber: [217, 119, 6] as RGB,
  // BESS-specific green header band
  bessHeaderBg: [5, 122, 85] as RGB,      // #057A55 emerald-700
  bessHeaderText: [255, 255, 255] as RGB,
};

// ============================================================
// Helpers
// ============================================================

function formatCurrency(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `\u20AC${(value / 1_000_000).toFixed(2)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `\u20AC${(value / 1_000).toFixed(0)}K`;
  }
  return `\u20AC${value.toFixed(0)}`;
}

function formatPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function riskColor(level: string): RGB {
  switch (level.toLowerCase()) {
    case 'low': return COLORS.green;
    case 'medium':
    case 'moderate': return COLORS.amber;
    case 'high':
    case 'critical': return COLORS.red;
    default: return COLORS.textPrimary;
  }
}

function degradationColor(rate: number): RGB {
  if (rate < 2) return COLORS.green;
  if (rate <= 4) return COLORS.amber;
  return COLORS.red;
}

function availabilityColor(pct: number): RGB {
  if (pct >= 98) return COLORS.green;
  if (pct >= 95) return COLORS.amber;
  return COLORS.red;
}

function checkPageBreak(doc: jsPDF, yPos: number, needed: number, margin: number): number {
  const pageHeight = doc.internal.pageSize.getHeight();
  if (yPos + needed > pageHeight - margin) {
    doc.addPage();
    return margin + 5;
  }
  return yPos;
}

/**
 * Determine whether a given section should be included.
 * If `sections` array is provided and non-empty, use it.
 * Otherwise fall back to the legacy boolean fields.
 */
/** Section-id aliases: the schedule modal historically stored 'plant_risk'
 *  for the section this renderer keys as 'risk_performance'. */
const SECTION_ALIASES: Record<string, string[]> = {
  risk_performance: ['plant_risk'],
};

function shouldInclude(
  data: ReportData,
  sectionKey: string,
  legacyFlag?: boolean
): boolean {
  if (data.sections && data.sections.length > 0) {
    if (data.sections.includes(sectionKey)) return true;
    return (SECTION_ALIASES[sectionKey] ?? []).some((a) => data.sections!.includes(a));
  }
  return legacyFlag ?? false;
}

// ============================================================
// Compliance Section
// ============================================================

/**
 * Render a per-plant compliance checklist covering grid code, metering, and
 * reporting obligations driven by the plant's country compliance pack.
 */
function renderComplianceSection(
  doc: jsPDF,
  yPos: number,
  summaries: CompliancePlantSummary[],
  margin: number,
  contentWidth: number
): number {
  const pageHeight = doc.internal.pageSize.getHeight();

  // Section header band — purple to distinguish from portfolio/BESS
  const complianceHeaderBg: RGB = [88, 28, 135]; // purple-900
  doc.setFillColor(...complianceHeaderBg);
  doc.rect(margin, yPos, contentWidth, 10, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Compliance & Regulatory Obligations', margin + 4, yPos + 7);
  yPos += 14;

  for (const s of summaries) {
    // Page-break guard
    if (yPos > pageHeight - 60) {
      doc.addPage();
      yPos = 20;
    }

    // Plant header
    doc.setFillColor(...COLORS.tableHeaderBg);
    doc.rect(margin, yPos, contentWidth, 8, 'F');
    doc.setTextColor(...COLORS.textPrimary);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text(`${s.plantName}  (${s.country})`, margin + 2, yPos + 5.5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.textSecondary);
    doc.text(`Pack v${s.packVersion}`, margin + contentWidth - 2, yPos + 5.5, { align: 'right' });
    yPos += 10;

    // Meta grid
    doc.setTextColor(...COLORS.textPrimary);
    doc.setFontSize(9);
    const col1 = margin + 2;
    const col2 = margin + contentWidth / 2;
    doc.setFont('helvetica', 'bold');
    doc.text('Regulator:', col1, yPos);
    doc.text('Grid operator:', col2, yPos);
    doc.setFont('helvetica', 'normal');
    doc.text(s.regulator, col1 + 22, yPos);
    doc.text(s.gridOperator, col2 + 28, yPos);
    yPos += 5;
    doc.setFont('helvetica', 'bold');
    doc.text('Grid code:', col1, yPos);
    doc.text('Meter class:', col2, yPos);
    doc.setFont('helvetica', 'normal');
    doc.text(s.gridCodeReference, col1 + 22, yPos);
    doc.text(s.meterClass, col2 + 28, yPos);
    yPos += 7;

    // Obligations table
    if (s.obligations.length > 0) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(...COLORS.textSecondary);
      doc.text('Reporting obligation', col1, yPos);
      doc.text('Recipient', margin + contentWidth * 0.5, yPos);
      doc.text('Cadence', margin + contentWidth * 0.72, yPos);
      doc.text('Deadline', margin + contentWidth * 0.88, yPos);
      yPos += 2;
      doc.setDrawColor(...COLORS.borderLight);
      doc.line(margin, yPos, margin + contentWidth, yPos);
      yPos += 3;

      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.textPrimary);
      for (const o of s.obligations) {
        if (yPos > pageHeight - 20) {
          doc.addPage();
          yPos = 20;
        }
        doc.text(o.name, col1, yPos, { maxWidth: contentWidth * 0.46 });
        doc.text(o.recipient, margin + contentWidth * 0.5, yPos);
        doc.text(o.cadence, margin + contentWidth * 0.72, yPos);
        doc.text(`${o.deadlineDays}d after period`, margin + contentWidth * 0.88, yPos);
        yPos += 5;
      }
    } else {
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(...COLORS.textSecondary);
      doc.text('No reporting obligations apply at this capacity / asset type.', col1, yPos);
      yPos += 5;
    }

    yPos += 4;
  }

  return yPos + 4;
}

// ============================================================
// Contract Obligations Section
// ============================================================

function contractStatusColor(status: string): RGB {
  switch (status) {
    case 'ok': return COLORS.green;
    case 'at_risk': return COLORS.amber;
    case 'breach': return COLORS.red;
    default: return COLORS.textSecondary;
  }
}

function contractStatusLabel(status: string): string {
  switch (status) {
    case 'ok': return 'On track';
    case 'at_risk': return 'At risk';
    case 'breach': return 'BREACH';
    case 'no_data': return 'No data';
    default: return 'Terms on file';
  }
}

function renderContractObligationsSection(
  doc: jsPDF,
  yPos: number,
  rows: ContractObligationRow[],
  margin: number,
  contentWidth: number
): number {
  yPos = checkPageBreak(doc, yPos, 24 + rows.length * 6, margin);

  // Amber band to distinguish from portfolio/BESS/compliance sections.
  const bandBg: RGB = [180, 83, 9]; // amber-700
  doc.setFillColor(...bandBg);
  doc.rect(margin, yPos, contentWidth, 10, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Contract Obligations', margin + 4, yPos + 7);
  yPos += 14;

  const colWidths = [
    contentWidth * 0.2, // Plant
    contentWidth * 0.16, // Contract
    contentWidth * 0.26, // Obligation
    contentWidth * 0.13, // Status
    contentWidth * 0.13, // Observed
    contentWidth * 0.12, // Threshold
  ];
  const headers = ['Plant', 'Contract', 'Obligation', 'Status', 'Observed', 'Threshold'];

  doc.setFillColor(...COLORS.tableHeaderBg);
  doc.rect(margin, yPos, contentWidth, 7, 'F');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...COLORS.textPrimary);
  let xOffset = margin + 2;
  headers.forEach((h, i) => {
    doc.text(h, xOffset, yPos + 5);
    xOffset += colWidths[i];
  });
  yPos += 9;

  doc.setFont('helvetica', 'normal');
  rows.forEach((row, i) => {
    yPos = checkPageBreak(doc, yPos, 7, margin);
    if (i % 2 === 1) {
      doc.setFillColor(...COLORS.tableRowAlt);
      doc.rect(margin, yPos - 1, contentWidth, 7, 'F');
    }
    doc.setFontSize(7);
    xOffset = margin + 2;
    doc.setTextColor(...COLORS.textPrimary);
    doc.text(row.plantName, xOffset, yPos + 4, { maxWidth: colWidths[0] - 3 });
    xOffset += colWidths[0];
    doc.text(row.contractType, xOffset, yPos + 4, { maxWidth: colWidths[1] - 3 });
    xOffset += colWidths[1];
    doc.text(row.field, xOffset, yPos + 4, { maxWidth: colWidths[2] - 3 });
    xOffset += colWidths[2];
    doc.setTextColor(...contractStatusColor(row.status));
    doc.setFont('helvetica', row.status === 'breach' ? 'bold' : 'normal');
    doc.text(contractStatusLabel(row.status), xOffset, yPos + 4);
    doc.setFont('helvetica', 'normal');
    xOffset += colWidths[3];
    doc.setTextColor(...COLORS.textPrimary);
    doc.text(row.observed, xOffset, yPos + 4);
    xOffset += colWidths[4];
    doc.text(row.threshold, xOffset, yPos + 4);
    yPos += 7;
  });

  yPos += 4;
  doc.setFontSize(6);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(...COLORS.textSecondary);
  doc.text(
    'Statuses from the platform’s hourly obligation evaluation (energy-proxy / trend metrics, not contractual settlement).',
    margin,
    yPos
  );
  return yPos + 8;
}

// ============================================================
// BESS Section Helpers
// ============================================================

/** Render green BESS section header band + title. */
function renderBessSectionHeader(
  doc: jsPDF,
  yPos: number,
  title: string,
  margin: number,
  contentWidth: number
): number {
  const pageWidth = doc.internal.pageSize.getWidth();
  doc.setFillColor(...COLORS.bessHeaderBg);
  doc.rect(margin, yPos, contentWidth, 8, 'F');

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...COLORS.bessHeaderText);
  doc.text(title, margin + 3, yPos + 5.5);

  doc.setTextColor(...COLORS.textPrimary);
  return yPos + 12;
}

// ============================================================
// BESS Section Renderers
// ============================================================

function renderBessKpiSection(
  doc: jsPDF,
  yPos: number,
  bessData: BessReportData[],
  margin: number,
  contentWidth: number
): number {
  yPos = checkPageBreak(doc, yPos, 60, margin);
  yPos = renderBessSectionHeader(doc, yPos, 'BESS Key Performance Indicators', margin, contentWidth);

  for (const asset of bessData) {
    yPos = checkPageBreak(doc, yPos, 50, margin);

    // Asset sub-header
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLORS.textPrimary);
    doc.text(`${asset.assetName}  (${asset.chemistry}, ${asset.capacityKwh} kWh / ${asset.powerKw} kW)`, margin, yPos);
    yPos += 6;

    // KPI grid, 2 columns
    const metrics: [string, string][] = [
      ['State of Health', `${(asset.currentSoh * 100).toFixed(1)}%`],
      ['Equivalent Cycles', `${asset.equivalentCycles.toFixed(0)}`],
      ['Total Throughput', `${asset.totalThroughputMwh.toFixed(1)} MWh`],
      ['Warranty Health Score', `${asset.warrantyHealthScore}`],
      ['Avg Round-Trip Efficiency', `${(asset.avgRte * 100).toFixed(1)}%`],
      ['Warranty Risk', asset.warrantyRiskLevel],
    ];

    const colWidth = contentWidth / 2;
    metrics.forEach(([label, value], i) => {
      const col = i % 2;
      const x = margin + col * colWidth;

      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.textSecondary);
      doc.text(label, x, yPos);

      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...COLORS.textPrimary);
      doc.text(value, x, yPos + 4.5);

      if (col === 1) {
        yPos += 12;
      }
    });

    if (metrics.length % 2 !== 0) {
      yPos += 12;
    }
    yPos += 4;
  }

  return yPos;
}

function renderBessSohSection(
  doc: jsPDF,
  yPos: number,
  bessData: BessReportData[],
  margin: number,
  contentWidth: number
): number {
  yPos = checkPageBreak(doc, yPos, 50, margin);
  yPos = renderBessSectionHeader(doc, yPos, 'BESS State of Health History', margin, contentWidth);

  for (const asset of bessData) {
    yPos = checkPageBreak(doc, yPos, 30, margin);

    // Asset sub-header with current SoH prominent
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLORS.textPrimary);
    doc.text(asset.assetName, margin, yPos);

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    const sohStr = `Current SoH: ${(asset.currentSoh * 100).toFixed(1)}%`;
    doc.text(sohStr, margin + contentWidth * 0.45, yPos);

    if (asset.projectedEolDate) {
      doc.setTextColor(...COLORS.textSecondary);
      doc.text(`Projected EOL: ${asset.projectedEolDate}`, margin + contentWidth * 0.72, yPos);
    }
    doc.setTextColor(...COLORS.textPrimary);
    yPos += 5;

    // Table of SoH history
    const colWidths = [contentWidth * 0.35, contentWidth * 0.35, contentWidth * 0.3];
    const headers = ['Date', 'SoH (%)', 'Change'];

    doc.setFillColor(...COLORS.tableHeaderBg);
    doc.rect(margin, yPos, contentWidth, 6, 'F');
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    let xOffset = margin + 2;
    headers.forEach((h, i) => {
      doc.text(h, xOffset, yPos + 4);
      xOffset += colWidths[i];
    });
    yPos += 7;

    // Show last 10 points to keep the table concise
    const recentHistory = asset.sohHistory.slice(-10);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    recentHistory.forEach((point, i) => {
      yPos = checkPageBreak(doc, yPos, 6, margin);
      if (i % 2 === 1) {
        doc.setFillColor(...COLORS.tableRowAlt);
        doc.rect(margin, yPos - 1, contentWidth, 6, 'F');
      }

      xOffset = margin + 2;
      doc.setTextColor(...COLORS.textPrimary);
      doc.text(point.date, xOffset, yPos + 3.5);
      xOffset += colWidths[0];

      doc.text(`${(point.soh * 100).toFixed(2)}%`, xOffset, yPos + 3.5);
      xOffset += colWidths[1];

      // Compute change from previous point
      const prevIdx = asset.sohHistory.indexOf(point) - 1;
      if (prevIdx >= 0) {
        const delta = (point.soh - asset.sohHistory[prevIdx].soh) * 100;
        const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%`;
        doc.setTextColor(...(delta < 0 ? COLORS.red : COLORS.green));
        doc.text(deltaStr, xOffset, yPos + 3.5);
      } else {
        doc.setTextColor(...COLORS.textSecondary);
        doc.text('-', xOffset, yPos + 3.5);
      }

      yPos += 6;
    });

    yPos += 6;
  }

  return yPos;
}

function renderBessDegradationSection(
  doc: jsPDF,
  yPos: number,
  bessData: BessReportData[],
  margin: number,
  contentWidth: number
): number {
  yPos = checkPageBreak(doc, yPos, 40, margin);
  yPos = renderBessSectionHeader(doc, yPos, 'BESS Degradation Analysis', margin, contentWidth);

  // Table
  const colWidths = [
    contentWidth * 0.22,  // Asset
    contentWidth * 0.13,  // Chemistry
    contentWidth * 0.17,  // Degradation
    contentWidth * 0.20,  // Projected EOL
    contentWidth * 0.15,  // Cycles to EOL
    contentWidth * 0.13,  // Current SoH
  ];
  const headers = ['Asset', 'Chemistry', 'Degrad. (%/yr)', 'Projected EOL', 'Cycles to EOL', 'SoH'];

  doc.setFillColor(...COLORS.tableHeaderBg);
  doc.rect(margin, yPos, contentWidth, 7, 'F');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...COLORS.textPrimary);
  let xOffset = margin + 2;
  headers.forEach((h, i) => {
    doc.text(h, xOffset, yPos + 5);
    xOffset += colWidths[i];
  });
  yPos += 9;

  doc.setFont('helvetica', 'normal');
  bessData.forEach((asset, i) => {
    yPos = checkPageBreak(doc, yPos, 7, margin);

    if (i % 2 === 1) {
      doc.setFillColor(...COLORS.tableRowAlt);
      doc.rect(margin, yPos - 1, contentWidth, 7, 'F');
    }

    doc.setFontSize(7);
    xOffset = margin + 2;

    // Asset name
    doc.setTextColor(...COLORS.textPrimary);
    doc.text(asset.assetName, xOffset, yPos + 4);
    xOffset += colWidths[0];

    // Chemistry
    doc.text(asset.chemistry, xOffset, yPos + 4);
    xOffset += colWidths[1];

    // Degradation rate - color coded
    doc.setTextColor(...degradationColor(asset.degradationRate));
    doc.text(`${asset.degradationRate.toFixed(2)}%`, xOffset, yPos + 4);
    xOffset += colWidths[2];

    // Projected EOL
    doc.setTextColor(...COLORS.textPrimary);
    doc.text(asset.projectedEolDate ?? 'N/A', xOffset, yPos + 4);
    xOffset += colWidths[3];

    // Cycles to EOL
    doc.text(asset.cyclesToEol !== null ? `${asset.cyclesToEol}` : 'N/A', xOffset, yPos + 4);
    xOffset += colWidths[4];

    // Current SoH
    doc.text(`${(asset.currentSoh * 100).toFixed(1)}%`, xOffset, yPos + 4);

    yPos += 7;
  });

  // Legend
  yPos += 4;
  doc.setFontSize(6);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(...COLORS.textSecondary);
  doc.text('Color coding: Green < 2%/yr | Amber 2-4%/yr | Red > 4%/yr', margin, yPos);
  yPos += 8;

  return yPos;
}

function renderBessDispatchSection(
  doc: jsPDF,
  yPos: number,
  bessData: BessReportData[],
  margin: number,
  contentWidth: number
): number {
  yPos = checkPageBreak(doc, yPos, 40, margin);
  yPos = renderBessSectionHeader(doc, yPos, 'BESS Dispatch & Revenue', margin, contentWidth);

  // Table
  const colWidths = [
    contentWidth * 0.20,  // Asset
    contentWidth * 0.16,  // Avg Daily Charge
    contentWidth * 0.16,  // Avg Daily Discharge
    contentWidth * 0.16,  // Revenue
    contentWidth * 0.16,  // Degradation Cost
    contentWidth * 0.16,  // Net Revenue
  ];
  const headers = ['Asset', 'Avg Charge', 'Avg Discharge', 'Revenue', 'Degrad. Cost', 'Net Revenue'];

  doc.setFillColor(...COLORS.tableHeaderBg);
  doc.rect(margin, yPos, contentWidth, 7, 'F');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...COLORS.textPrimary);
  let xOffset = margin + 2;
  headers.forEach((h, i) => {
    doc.text(h, xOffset, yPos + 5);
    xOffset += colWidths[i];
  });
  yPos += 9;

  doc.setFont('helvetica', 'normal');
  bessData.forEach((asset, i) => {
    yPos = checkPageBreak(doc, yPos, 7, margin);

    if (i % 2 === 1) {
      doc.setFillColor(...COLORS.tableRowAlt);
      doc.rect(margin, yPos - 1, contentWidth, 7, 'F');
    }

    doc.setFontSize(7);
    xOffset = margin + 2;

    // Asset name
    doc.setTextColor(...COLORS.textPrimary);
    doc.text(asset.assetName, xOffset, yPos + 4);
    xOffset += colWidths[0];

    // Avg Daily Charge MWh
    doc.text(`${asset.avgDailyChargeMwh.toFixed(2)} MWh`, xOffset, yPos + 4);
    xOffset += colWidths[1];

    // Avg Daily Discharge MWh
    doc.text(`${asset.avgDailyDischargeMwh.toFixed(2)} MWh`, xOffset, yPos + 4);
    xOffset += colWidths[2];

    // Revenue
    doc.setTextColor(...COLORS.green);
    doc.text(formatCurrency(asset.recentRevenue), xOffset, yPos + 4);
    xOffset += colWidths[3];

    // Degradation Cost
    doc.setTextColor(...COLORS.red);
    doc.text(formatCurrency(asset.recentDegradationCost), xOffset, yPos + 4);
    xOffset += colWidths[4];

    // Net Revenue
    const netRevenue = asset.recentRevenue - asset.recentDegradationCost;
    doc.setTextColor(...(netRevenue >= 0 ? COLORS.green : COLORS.red));
    doc.text(formatCurrency(netRevenue), xOffset, yPos + 4);

    yPos += 7;
  });

  yPos += 8;
  return yPos;
}

function renderBessLossSection(
  doc: jsPDF,
  yPos: number,
  bessData: BessReportData[],
  margin: number,
  contentWidth: number
): number {
  yPos = checkPageBreak(doc, yPos, 40, margin);
  yPos = renderBessSectionHeader(doc, yPos, 'BESS Losses & Availability', margin, contentWidth);

  // Table
  const colWidths = [
    contentWidth * 0.22,  // Asset
    contentWidth * 0.20,  // RTE Loss
    contentWidth * 0.18,  // Availability
    contentWidth * 0.18,  // Violations
    contentWidth * 0.22,  // Total Throughput
  ];
  const headers = ['Asset', 'RTE Loss (MWh)', 'Availability %', 'Violations', 'Throughput (MWh)'];

  doc.setFillColor(...COLORS.tableHeaderBg);
  doc.rect(margin, yPos, contentWidth, 7, 'F');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...COLORS.textPrimary);
  let xOffset = margin + 2;
  headers.forEach((h, i) => {
    doc.text(h, xOffset, yPos + 5);
    xOffset += colWidths[i];
  });
  yPos += 9;

  doc.setFont('helvetica', 'normal');
  bessData.forEach((asset, i) => {
    yPos = checkPageBreak(doc, yPos, 7, margin);

    if (i % 2 === 1) {
      doc.setFillColor(...COLORS.tableRowAlt);
      doc.rect(margin, yPos - 1, contentWidth, 7, 'F');
    }

    doc.setFontSize(7);
    xOffset = margin + 2;

    // Asset name
    doc.setTextColor(...COLORS.textPrimary);
    doc.text(asset.assetName, xOffset, yPos + 4);
    xOffset += colWidths[0];

    // RTE Loss
    doc.text(`${asset.rteLossMwh.toFixed(1)}`, xOffset, yPos + 4);
    xOffset += colWidths[1];

    // Availability - color coded
    doc.setTextColor(...availabilityColor(asset.availabilityPct));
    doc.text(`${asset.availabilityPct.toFixed(1)}%`, xOffset, yPos + 4);
    xOffset += colWidths[2];

    // Violations
    doc.setTextColor(...(asset.violationCount > 0 ? COLORS.red : COLORS.green));
    doc.text(`${asset.violationCount}`, xOffset, yPos + 4);
    xOffset += colWidths[3];

    // Total Throughput
    doc.setTextColor(...COLORS.textPrimary);
    doc.text(`${asset.totalThroughputMwh.toFixed(1)}`, xOffset, yPos + 4);

    yPos += 7;
  });

  // Legend
  yPos += 4;
  doc.setFontSize(6);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(...COLORS.textSecondary);
  doc.text('Availability color: Green >= 98% | Amber 95-98% | Red < 95%', margin, yPos);
  yPos += 8;

  return yPos;
}

// ============================================================
// Main Export
// ============================================================

export function generatePortfolioReportPdf(data: ReportData): ArrayBuffer {
  const doc = new jsPDF('p', 'mm', 'a4');
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 15;
  const contentWidth = pageWidth - 2 * margin;
  let yPos = margin;

  // ── Page Header ──────────────────────────────────────────
  doc.setFillColor(...COLORS.headerBg);
  doc.rect(0, 0, pageWidth, 40, 'F');

  doc.setTextColor(...COLORS.headerText);
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.text('NuraVolt', margin, 18);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Portfolio Intelligence Report', margin, 26);

  doc.setFontSize(9);
  doc.text(data.reportName, pageWidth - margin, 18, { align: 'right' });
  doc.text(`Period: ${data.period}`, pageWidth - margin, 24, { align: 'right' });
  doc.text(`Generated: ${data.generatedAt}`, pageWidth - margin, 30, { align: 'right' });

  doc.setTextColor(...COLORS.textPrimary);
  yPos = 50;

  // ── Portfolio Summary ────────────────────────────────────
  if (shouldInclude(data, 'portfolio_summary', data.includeSummary)) {
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('Portfolio Summary', margin, yPos);
    yPos += 8;

    doc.setDrawColor(...COLORS.borderLight);
    doc.setLineWidth(0.3);
    doc.line(margin, yPos, pageWidth - margin, yPos);
    yPos += 6;

    const metrics = [
      ['Total Plants', `${data.summary.totalPlants}`],
      ['Total Capacity', `${data.summary.totalCapacity_MW.toFixed(1)} MW`],
      ['Total Revenue', formatCurrency(data.summary.totalRevenue)],
      ['Revenue at Risk', formatCurrency(data.summary.totalRevenueAtRisk)],
      ['Budget Deviation', formatPct(data.summary.budgetDeviation)],
      ['Portfolio Risk', `${data.summary.riskScore} (${data.summary.riskLevel})`],
    ];

    const colWidth = contentWidth / 2;
    metrics.forEach(([label, value], i) => {
      const col = i % 2;
      const x = margin + col * colWidth;

      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.textSecondary);
      doc.text(label, x, yPos);

      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...COLORS.textPrimary);
      doc.text(value, x, yPos + 5);

      if (col === 1) {
        yPos += 14;
      }
    });

    // Handle odd number of metrics
    if (metrics.length % 2 !== 0) {
      yPos += 14;
    }

    yPos += 6;
  }

  // ── Loss Breakdown Table ─────────────────────────────────
  if (shouldInclude(data, 'loss_breakdown', data.includeLosses)) {
    yPos = checkPageBreak(doc, yPos, 20 + data.plants.length * 7, margin);

    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLORS.textPrimary);
    doc.text('Loss Breakdown', margin, yPos);
    yPos += 8;

    doc.setDrawColor(...COLORS.borderLight);
    doc.setLineWidth(0.3);
    doc.line(margin, yPos, pageWidth - margin, yPos);
    yPos += 4;

    // Table header
    const lossColWidths = [contentWidth * 0.4, contentWidth * 0.2, contentWidth * 0.2, contentWidth * 0.2];
    const lossHeaders = ['Plant', 'Soiling Loss', 'Fault Loss', 'Total Loss'];

    doc.setFillColor(...COLORS.tableHeaderBg);
    doc.rect(margin, yPos, contentWidth, 7, 'F');

    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLORS.textPrimary);
    let xOffset = margin + 2;
    lossHeaders.forEach((header, i) => {
      doc.text(header, xOffset, yPos + 5);
      xOffset += lossColWidths[i];
    });
    yPos += 9;

    // Table rows
    doc.setFont('helvetica', 'normal');
    data.plants.forEach((plant, i) => {
      yPos = checkPageBreak(doc, yPos, 7, margin);

      if (i % 2 === 1) {
        doc.setFillColor(...COLORS.tableRowAlt);
        doc.rect(margin, yPos - 1, contentWidth, 7, 'F');
      }

      doc.setFontSize(8);
      doc.setTextColor(...COLORS.textPrimary);
      xOffset = margin + 2;
      const totalLoss = plant.soilingLoss + plant.faultLoss;
      const rowData = [
        plant.plantName,
        formatCurrency(plant.soilingLoss),
        formatCurrency(plant.faultLoss),
        formatCurrency(totalLoss),
      ];
      rowData.forEach((val, j) => {
        doc.text(val, xOffset, yPos + 4);
        xOffset += lossColWidths[j];
      });
      yPos += 7;
    });

    // Totals row
    yPos = checkPageBreak(doc, yPos, 9, margin);
    doc.setDrawColor(...COLORS.borderLight);
    doc.line(margin, yPos, pageWidth - margin, yPos);
    yPos += 2;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    xOffset = margin + 2;
    const totalSoiling = data.summary.totalSoilingLoss;
    const totalFault = data.summary.totalFaultLoss;
    const totalsRow = ['Total', formatCurrency(totalSoiling), formatCurrency(totalFault), formatCurrency(totalSoiling + totalFault)];
    totalsRow.forEach((val, j) => {
      doc.text(val, xOffset, yPos + 4);
      xOffset += lossColWidths[j];
    });
    yPos += 12;
  }

  // ── Per-Plant Risk & Performance Table ───────────────────
  if (shouldInclude(data, 'risk_performance', data.includeRisk)) {
    yPos = checkPageBreak(doc, yPos, 20 + data.plants.length * 7, margin);

    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLORS.textPrimary);
    doc.text('Plant Risk & Performance', margin, yPos);
    yPos += 8;

    doc.setDrawColor(...COLORS.borderLight);
    doc.setLineWidth(0.3);
    doc.line(margin, yPos, pageWidth - margin, yPos);
    yPos += 4;

    // Table header
    const riskColWidths = [
      contentWidth * 0.18, // Plant
      contentWidth * 0.10, // Capacity
      contentWidth * 0.10, // Health
      contentWidth * 0.10, // Risk
      contentWidth * 0.15, // Rev at Risk
      contentWidth * 0.13, // Budget Dev
      contentWidth * 0.12, // Availability
      contentWidth * 0.12, // PR
    ];
    const riskHeaders = ['Plant', 'Cap (MW)', 'Health', 'Risk', 'Rev at Risk', 'Bdgt Dev', 'Avail %', 'PR'];

    doc.setFillColor(...COLORS.tableHeaderBg);
    doc.rect(margin, yPos, contentWidth, 7, 'F');

    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLORS.textPrimary);
    let xOffset = margin + 2;
    riskHeaders.forEach((header, i) => {
      doc.text(header, xOffset, yPos + 5);
      xOffset += riskColWidths[i];
    });
    yPos += 9;

    // Table rows
    doc.setFont('helvetica', 'normal');
    data.plants.forEach((plant, i) => {
      yPos = checkPageBreak(doc, yPos, 7, margin);

      if (i % 2 === 1) {
        doc.setFillColor(...COLORS.tableRowAlt);
        doc.rect(margin, yPos - 1, contentWidth, 7, 'F');
      }

      doc.setFontSize(7);
      xOffset = margin + 2;

      // Plant name
      doc.setTextColor(...COLORS.textPrimary);
      doc.text(plant.plantName, xOffset, yPos + 4);
      xOffset += riskColWidths[0];

      // Capacity
      doc.text(plant.capacity_MW.toFixed(1), xOffset, yPos + 4);
      xOffset += riskColWidths[1];

      // Health
      const healthStr = plant.healthScore !== null ? `${plant.healthScore}` : 'N/A';
      doc.text(healthStr, xOffset, yPos + 4);
      xOffset += riskColWidths[2];

      // Risk
      doc.setTextColor(...riskColor(plant.riskLevel));
      doc.text(`${plant.riskScore} (${plant.riskLevel})`, xOffset, yPos + 4);
      xOffset += riskColWidths[3];

      // Revenue at Risk
      doc.setTextColor(...COLORS.textPrimary);
      doc.text(formatCurrency(plant.revenueAtRisk), xOffset, yPos + 4);
      xOffset += riskColWidths[4];

      // Budget Deviation
      const devColor = plant.budgetDeviation < 0 ? COLORS.red : COLORS.green;
      doc.setTextColor(...devColor);
      doc.text(formatPct(plant.budgetDeviation), xOffset, yPos + 4);
      xOffset += riskColWidths[5];

      // Availability
      doc.setTextColor(...COLORS.textPrimary);
      doc.text(`${plant.availability.toFixed(1)}%`, xOffset, yPos + 4);
      xOffset += riskColWidths[6];

      // PR
      doc.text(`${(plant.performanceRatio * 100).toFixed(1)}%`, xOffset, yPos + 4);

      yPos += 7;
    });

    yPos += 6;
  }

  // ── Contract Obligations ────────────────────────────────
  if (
    data.contractRows &&
    data.contractRows.length > 0 &&
    shouldInclude(data, 'contract_obligations', false)
  ) {
    yPos = renderContractObligationsSection(doc, yPos, data.contractRows, margin, contentWidth);
  }

  // ── Compliance Sections ─────────────────────────────────
  const complianceSummaries = data.complianceSummaries;
  if (
    complianceSummaries &&
    complianceSummaries.length > 0 &&
    shouldInclude(data, 'compliance_obligations', false)
  ) {
    yPos = renderComplianceSection(doc, yPos, complianceSummaries, margin, contentWidth);
  }

  // ── BESS Sections ───────────────────────────────────────
  const bessData = data.bessData;
  const hasBessData = bessData && bessData.length > 0;

  if (hasBessData && shouldInclude(data, 'bess_kpi', false)) {
    yPos = renderBessKpiSection(doc, yPos, bessData, margin, contentWidth);
  }

  if (hasBessData && shouldInclude(data, 'bess_soh', false)) {
    yPos = renderBessSohSection(doc, yPos, bessData, margin, contentWidth);
  }

  if (hasBessData && shouldInclude(data, 'bess_degradation', false)) {
    yPos = renderBessDegradationSection(doc, yPos, bessData, margin, contentWidth);
  }

  if (hasBessData && shouldInclude(data, 'bess_dispatch', false)) {
    yPos = renderBessDispatchSection(doc, yPos, bessData, margin, contentWidth);
  }

  if (hasBessData && shouldInclude(data, 'bess_losses', false)) {
    yPos = renderBessLossSection(doc, yPos, bessData, margin, contentWidth);
  }

  // ── Footer on every page ─────────────────────────────────
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLORS.textSecondary);
    doc.text('Generated by NuraVolt', margin, pageHeight - 8);
    doc.text(`Page ${p} of ${totalPages}`, pageWidth - margin, pageHeight - 8, { align: 'right' });
  }

  return doc.output('arraybuffer');
}
