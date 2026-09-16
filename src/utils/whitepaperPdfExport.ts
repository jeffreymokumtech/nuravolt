import jsPDF from 'jspdf';
import { format } from 'date-fns';

export interface WhitepaperExportOptions {
  title: string;
  subtitle?: string;
  author?: string;
  version?: string;
  sections: WhitepaperSection[];
  includeTableOfContents?: boolean;
  includeCoverPage?: boolean;
  customBranding?: BrandingOptions;
}

export interface WhitepaperSection {
  title: string;
  level: 1 | 2 | 3; // h1, h2, h3
  content?: string;
  bulletPoints?: string[];
  table?: TableData;
  keyMetrics?: KeyMetric[];
  callout?: CalloutBox;
}

export interface TableData {
  headers: string[];
  rows: string[][];
  caption?: string;
}

export interface KeyMetric {
  label: string;
  value: string;
  highlight?: boolean;
}

export interface CalloutBox {
  type: 'info' | 'success' | 'warning' | 'highlight';
  title?: string;
  content: string;
}

export interface BrandingOptions {
  primaryColor?: [number, number, number];
  accentColor?: [number, number, number];
  companyName?: string;
  tagline?: string;
}

// NuraVolt brand colors
const BRAND_COLORS = {
  primary: [0, 111, 238] as [number, number, number],      // #006FEE - blue-600
  secondary: [230, 241, 255] as [number, number, number],  // #E6F1FF - blue-50
  accent: [51, 147, 255] as [number, number, number],      // #3393FF - blue-400
  dark: [0, 23, 48] as [number, number, number],           // #001730 - blue-900
  success: [16, 185, 129] as [number, number, number],     // #10B981
  warning: [245, 158, 11] as [number, number, number],     // #F59E0B
  gray: [107, 114, 128] as [number, number, number],       // #6B7280
};

class WhitepaperPdfGenerator {
  private pdf: jsPDF;
  private pageWidth: number;
  private pageHeight: number;
  private margin: number;
  private yPos: number;
  private pageNumber: number;
  private tocEntries: { title: string; page: number; level: number }[];
  private branding: BrandingOptions;

  constructor(branding?: BrandingOptions) {
    this.pdf = new jsPDF('p', 'mm', 'a4');
    this.pageWidth = this.pdf.internal.pageSize.getWidth();
    this.pageHeight = this.pdf.internal.pageSize.getHeight();
    this.margin = 20;
    this.yPos = this.margin;
    this.pageNumber = 1;
    this.tocEntries = [];
    this.branding = {
      primaryColor: BRAND_COLORS.primary,
      accentColor: BRAND_COLORS.accent,
      companyName: 'NuraVolt',
      tagline: 'Physics-Informed Energy Intelligence',
      ...branding,
    };
  }

  private checkPageBreak(requiredSpace: number): void {
    if (this.yPos + requiredSpace > this.pageHeight - 25) {
      this.addPage();
    }
  }

  private addPage(): void {
    this.pdf.addPage();
    this.pageNumber++;
    this.yPos = this.margin;
    this.addPageHeader();
  }

  private addPageHeader(): void {
    // Subtle header line
    this.pdf.setDrawColor(...this.branding.primaryColor!);
    this.pdf.setLineWidth(0.5);
    this.pdf.line(this.margin, 12, this.pageWidth - this.margin, 12);

    // Company name on left
    this.pdf.setFontSize(8);
    this.pdf.setTextColor(...BRAND_COLORS.gray);
    this.pdf.text(this.branding.companyName!, this.margin, 10);

    // Page number on right
    this.pdf.text(
      `Page ${this.pageNumber}`,
      this.pageWidth - this.margin,
      10,
      { align: 'right' }
    );

    this.yPos = 20;
  }

  private addCoverPage(title: string, subtitle?: string, version?: string): void {
    // Background gradient effect (simulated with rectangles)
    this.pdf.setFillColor(...this.branding.primaryColor!);
    this.pdf.rect(0, 0, this.pageWidth, 100, 'F');

    // Accent stripe
    this.pdf.setFillColor(...this.branding.accentColor!);
    this.pdf.rect(0, 95, this.pageWidth, 8, 'F');

    // Logo area / Company name
    this.pdf.setFontSize(28);
    this.pdf.setTextColor(255, 255, 255);
    this.pdf.setFont('helvetica', 'bold');
    this.pdf.text(this.branding.companyName!, this.margin, 40);

    // Tagline
    this.pdf.setFontSize(11);
    this.pdf.setFont('helvetica', 'normal');
    this.pdf.text(this.branding.tagline!, this.margin, 50);

    // Main title
    this.pdf.setFontSize(32);
    this.pdf.setFont('helvetica', 'bold');
    this.pdf.setTextColor(...BRAND_COLORS.dark);

    const titleLines = this.pdf.splitTextToSize(title, this.pageWidth - 2 * this.margin);
    this.pdf.text(titleLines, this.margin, 130);

    // Subtitle
    if (subtitle) {
      this.pdf.setFontSize(14);
      this.pdf.setFont('helvetica', 'normal');
      this.pdf.setTextColor(...BRAND_COLORS.gray);
      const subtitleY = 130 + titleLines.length * 12 + 10;
      this.pdf.text(subtitle, this.margin, subtitleY);
    }

    // Document info box at bottom
    this.pdf.setFillColor(...BRAND_COLORS.secondary);
    this.pdf.roundedRect(this.margin, this.pageHeight - 60, this.pageWidth - 2 * this.margin, 40, 3, 3, 'F');

    this.pdf.setFontSize(10);
    this.pdf.setTextColor(...BRAND_COLORS.dark);
    this.pdf.setFont('helvetica', 'bold');
    this.pdf.text('Document Information', this.margin + 5, this.pageHeight - 50);

    this.pdf.setFont('helvetica', 'normal');
    this.pdf.setFontSize(9);
    this.pdf.text(`Version: ${version || '1.0'}`, this.margin + 5, this.pageHeight - 42);
    this.pdf.text(`Generated: ${format(new Date(), 'MMMM d, yyyy')}`, this.margin + 5, this.pageHeight - 36);
    this.pdf.text(`Prepared by: ${this.branding.companyName}`, this.margin + 5, this.pageHeight - 30);

    // Professional watermark/disclaimer
    this.pdf.setFontSize(7);
    this.pdf.setTextColor(...BRAND_COLORS.gray);
    this.pdf.text(
      'Confidential - For authorized distribution only',
      this.pageWidth / 2,
      this.pageHeight - 10,
      { align: 'center' }
    );
  }

  private addTableOfContents(): void {
    this.addPage();

    this.pdf.setFontSize(24);
    this.pdf.setFont('helvetica', 'bold');
    this.pdf.setTextColor(...BRAND_COLORS.dark);
    this.pdf.text('Table of Contents', this.margin, this.yPos);
    this.yPos += 15;

    // Placeholder - will be filled after all content is added
    this.pdf.setFontSize(10);
    this.pdf.setFont('helvetica', 'normal');
    this.pdf.setTextColor(...BRAND_COLORS.gray);
    this.pdf.text('(Generated after content processing)', this.margin, this.yPos);
    this.yPos += 20;
  }

  private addSectionTitle(title: string, level: 1 | 2 | 3): void {
    const fontSizes = { 1: 20, 2: 14, 3: 12 };
    const spacingBefore = { 1: 15, 2: 10, 3: 8 };
    const spacingAfter = { 1: 8, 2: 6, 3: 4 };

    this.checkPageBreak(spacingBefore[level] + fontSizes[level] + spacingAfter[level]);

    // Record TOC entry
    this.tocEntries.push({ title, page: this.pageNumber, level });

    this.yPos += spacingBefore[level];

    // Add accent bar for h1
    if (level === 1) {
      this.pdf.setFillColor(...this.branding.primaryColor!);
      this.pdf.rect(this.margin, this.yPos - 3, 4, fontSizes[level] + 2, 'F');
    }

    this.pdf.setFontSize(fontSizes[level]);
    this.pdf.setFont('helvetica', 'bold');
    this.pdf.setTextColor(...BRAND_COLORS.dark);

    const xOffset = level === 1 ? this.margin + 8 : this.margin + (level - 1) * 4;
    this.pdf.text(title, xOffset, this.yPos + fontSizes[level] / 4);

    this.yPos += fontSizes[level] / 2 + spacingAfter[level];
  }

  private addParagraph(content: string): void {
    this.pdf.setFontSize(10);
    this.pdf.setFont('helvetica', 'normal');
    this.pdf.setTextColor(50, 50, 50);

    const maxWidth = this.pageWidth - 2 * this.margin;
    const lines = this.pdf.splitTextToSize(content, maxWidth);

    this.checkPageBreak(lines.length * 5 + 4);

    this.pdf.text(lines, this.margin, this.yPos);
    this.yPos += lines.length * 5 + 4;
  }

  private addBulletPoints(points: string[]): void {
    this.pdf.setFontSize(10);
    this.pdf.setFont('helvetica', 'normal');

    points.forEach((point) => {
      this.checkPageBreak(8);

      // Bullet
      this.pdf.setFillColor(...this.branding.primaryColor!);
      this.pdf.circle(this.margin + 2, this.yPos - 1, 1.2, 'F');

      // Text
      this.pdf.setTextColor(50, 50, 50);
      const lines = this.pdf.splitTextToSize(point, this.pageWidth - 2 * this.margin - 10);
      this.pdf.text(lines, this.margin + 8, this.yPos);
      this.yPos += lines.length * 5 + 2;
    });

    this.yPos += 4;
  }

  private addTable(data: TableData): void {
    const colWidth = (this.pageWidth - 2 * this.margin) / data.headers.length;
    const rowHeight = 8;
    const headerHeight = 10;

    // Check space for at least header + 2 rows
    this.checkPageBreak(headerHeight + rowHeight * 3);

    // Caption
    if (data.caption) {
      this.pdf.setFontSize(9);
      this.pdf.setFont('helvetica', 'italic');
      this.pdf.setTextColor(...BRAND_COLORS.gray);
      this.pdf.text(data.caption, this.margin, this.yPos);
      this.yPos += 6;
    }

    // Header row
    this.pdf.setFillColor(...this.branding.primaryColor!);
    this.pdf.rect(this.margin, this.yPos, this.pageWidth - 2 * this.margin, headerHeight, 'F');

    this.pdf.setFontSize(9);
    this.pdf.setFont('helvetica', 'bold');
    this.pdf.setTextColor(255, 255, 255);

    data.headers.forEach((header, index) => {
      this.pdf.text(
        header,
        this.margin + index * colWidth + colWidth / 2,
        this.yPos + 6,
        { align: 'center' }
      );
    });

    this.yPos += headerHeight;

    // Data rows
    this.pdf.setFont('helvetica', 'normal');
    this.pdf.setTextColor(50, 50, 50);

    data.rows.forEach((row, rowIndex) => {
      this.checkPageBreak(rowHeight);

      // Alternating row colors
      if (rowIndex % 2 === 0) {
        this.pdf.setFillColor(248, 250, 252);
        this.pdf.rect(this.margin, this.yPos, this.pageWidth - 2 * this.margin, rowHeight, 'F');
      }

      row.forEach((cell, cellIndex) => {
        this.pdf.text(
          cell.substring(0, 25), // Truncate if too long
          this.margin + cellIndex * colWidth + colWidth / 2,
          this.yPos + 5,
          { align: 'center' }
        );
      });

      this.yPos += rowHeight;
    });

    this.yPos += 8;
  }

  private addKeyMetrics(metrics: KeyMetric[]): void {
    this.checkPageBreak(40);

    const metricsPerRow = Math.min(metrics.length, 4);
    const metricWidth = (this.pageWidth - 2 * this.margin - (metricsPerRow - 1) * 5) / metricsPerRow;
    const metricHeight = 30;

    metrics.forEach((metric, index) => {
      const row = Math.floor(index / metricsPerRow);
      const col = index % metricsPerRow;
      const x = this.margin + col * (metricWidth + 5);
      const y = this.yPos + row * (metricHeight + 5);

      // Check for page break at start of new row
      if (col === 0 && row > 0) {
        this.checkPageBreak(metricHeight + 5);
      }

      // Background
      const bgColor = metric.highlight ? this.branding.primaryColor! : BRAND_COLORS.secondary;
      this.pdf.setFillColor(...bgColor);
      this.pdf.roundedRect(x, y, metricWidth, metricHeight, 2, 2, 'F');

      // Value
      this.pdf.setFontSize(16);
      this.pdf.setFont('helvetica', 'bold');
      this.pdf.setTextColor(metric.highlight ? 255 : BRAND_COLORS.dark[0], metric.highlight ? 255 : BRAND_COLORS.dark[1], metric.highlight ? 255 : BRAND_COLORS.dark[2]);
      this.pdf.text(metric.value, x + metricWidth / 2, y + 12, { align: 'center' });

      // Label
      this.pdf.setFontSize(8);
      this.pdf.setFont('helvetica', 'normal');
      this.pdf.setTextColor(metric.highlight ? 230 : BRAND_COLORS.gray[0], metric.highlight ? 230 : BRAND_COLORS.gray[1], metric.highlight ? 230 : BRAND_COLORS.gray[2]);
      this.pdf.text(metric.label, x + metricWidth / 2, y + 22, { align: 'center' });
    });

    const totalRows = Math.ceil(metrics.length / metricsPerRow);
    this.yPos += totalRows * (metricHeight + 5) + 5;
  }

  private addCallout(callout: CalloutBox): void {
    this.checkPageBreak(25);

    const colors = {
      info: BRAND_COLORS.primary,
      success: BRAND_COLORS.success,
      warning: BRAND_COLORS.warning,
      highlight: BRAND_COLORS.accent,
    };

    const bgColors = {
      info: [230, 241, 255] as [number, number, number],
      success: [236, 253, 245] as [number, number, number],
      warning: [254, 252, 232] as [number, number, number],
      highlight: [239, 246, 255] as [number, number, number],
    };

    const borderColor = colors[callout.type];
    const backgroundColor = bgColors[callout.type];

    // Background
    this.pdf.setFillColor(...backgroundColor);
    this.pdf.roundedRect(this.margin, this.yPos, this.pageWidth - 2 * this.margin, 20, 2, 2, 'F');

    // Left border accent
    this.pdf.setFillColor(...borderColor);
    this.pdf.rect(this.margin, this.yPos, 3, 20, 'F');

    // Title
    if (callout.title) {
      this.pdf.setFontSize(10);
      this.pdf.setFont('helvetica', 'bold');
      this.pdf.setTextColor(...borderColor);
      this.pdf.text(callout.title, this.margin + 8, this.yPos + 6);
    }

    // Content
    this.pdf.setFontSize(9);
    this.pdf.setFont('helvetica', 'normal');
    this.pdf.setTextColor(50, 50, 50);
    const contentLines = this.pdf.splitTextToSize(callout.content, this.pageWidth - 2 * this.margin - 15);
    this.pdf.text(contentLines, this.margin + 8, this.yPos + (callout.title ? 13 : 10));

    this.yPos += Math.max(20, contentLines.length * 4 + 15) + 8;
  }

  private addFooter(): void {
    const totalPages = this.pdf.internal.pages.length - 1;

    for (let i = 1; i <= totalPages; i++) {
      this.pdf.setPage(i);

      // Footer line
      this.pdf.setDrawColor(...BRAND_COLORS.gray);
      this.pdf.setLineWidth(0.3);
      this.pdf.line(this.margin, this.pageHeight - 15, this.pageWidth - this.margin, this.pageHeight - 15);

      // Footer text
      this.pdf.setFontSize(8);
      this.pdf.setTextColor(...BRAND_COLORS.gray);
      this.pdf.text(
        `${this.branding.companyName} • ${this.branding.tagline}`,
        this.margin,
        this.pageHeight - 10
      );

      this.pdf.text(
        `Page ${i} of ${totalPages}`,
        this.pageWidth - this.margin,
        this.pageHeight - 10,
        { align: 'right' }
      );
    }
  }

  public generate(options: WhitepaperExportOptions): void {
    const {
      title,
      subtitle,
      version,
      sections,
      includeCoverPage = true,
      includeTableOfContents = true,
    } = options;

    // Cover page
    if (includeCoverPage) {
      this.addCoverPage(title, subtitle, version);
    }

    // Table of contents placeholder
    if (includeTableOfContents) {
      this.addTableOfContents();
    }

    // Content sections
    sections.forEach((section) => {
      this.addSectionTitle(section.title, section.level);

      if (section.content) {
        this.addParagraph(section.content);
      }

      if (section.keyMetrics) {
        this.addKeyMetrics(section.keyMetrics);
      }

      if (section.bulletPoints) {
        this.addBulletPoints(section.bulletPoints);
      }

      if (section.table) {
        this.addTable(section.table);
      }

      if (section.callout) {
        this.addCallout(section.callout);
      }
    });

    // Add footers
    this.addFooter();
  }

  public save(filename: string): void {
    this.pdf.save(filename);
  }

  public getBlob(): Blob {
    return this.pdf.output('blob');
  }
}

// Main export function
export async function exportWhitepaperToPDF(options: WhitepaperExportOptions): Promise<void> {
  const generator = new WhitepaperPdfGenerator(options.customBranding);
  generator.generate(options);

  const filename = `${options.title.toLowerCase().replace(/\s+/g, '-')}-${format(new Date(), 'yyyy-MM-dd')}.pdf`;
  generator.save(filename);
}

// Pre-built whitepaper templates
export const WHITEPAPER_TEMPLATES = {
  // Comprehensive Soiling Intelligence Whitepaper
  soilingIntelligence: (): WhitepaperExportOptions => ({
    title: 'Soiling Intelligence Technical Specification',
    subtitle: 'Physics-Informed Detection, Forecasting & Cleaning Optimization for Solar PV',
    version: '1.0',
    includeCoverPage: true,
    includeTableOfContents: true,
    sections: [
      {
        title: 'Executive Summary',
        level: 1,
        content: 'This document specifies the complete technical implementation of NuraVolt\'s soiling detection and cleaning optimization solution. The system combines physics-based detection with ML-enhanced prediction to optimize cleaning schedules, reduce costs by 30-35%, and provide advance warning of soiling accumulation patterns.',
        keyMetrics: [
          { label: 'Detection Accuracy', value: '94-97%', highlight: true },
          { label: 'Cost Reduction', value: '30-35%', highlight: false },
          { label: 'Forecast Horizon', value: '3-7 days', highlight: false },
          { label: 'Annual Value', value: '€650/MWp', highlight: false },
        ],
      },
      {
        title: 'Validated Field Deployments',
        level: 1,
        table: {
          headers: ['Deployment', 'Accuracy', 'Cost Reduction', 'Key Achievement'],
          rows: [
            ['Spanish 120MW', '94-97%', '32%', '2.4M liters water saved/year'],
            ['UAE 50MW', '95.3%', '28%', 'Extreme soiling (0.3-0.8%/day)'],
            ['Desert Knowledge AU', '95.1%', '31%', '15+ years validation data'],
          ],
          caption: 'Table 1: Global deployment validation results',
        },
      },
      {
        title: 'Physics-Based Detection',
        level: 1,
        content: 'The core detection method compares actual plane-of-array (POA) irradiance to theoretical clearsky irradiance to detect transmittance loss from soiling accumulation. Uses pvlib\'s Ineichen clearsky model with Haydavies transposition.',
        bulletPoints: [
          'Clearsky reference model: pvlib Ineichen with site-specific atmospheric parameters',
          'Soiling ratio calculation: Rolling 7-day median filter for transient effect removal',
          'Climate-specific thresholds: Arid (5-12%), Semi-arid (3-10%), Temperate (2-7%)',
          'No additional hardware required - software-only using existing SCADA data',
        ],
      },
      {
        title: 'ML-Enhanced Prediction',
        level: 1,
        content: 'LightGBM gradient boosting extends physics detection with pattern recognition for seasonal accumulation rates, weather-driven modeling, and micro-climate zone identification.',
        table: {
          headers: ['Feature', 'Importance', 'Physical Interpretation'],
          rows: [
            ['Clearsky Irradiance Ratio', '18.7%', 'Direct soiling indicator'],
            ['Performance Ratio 7d Mean', '12.3%', 'Short-term degradation trend'],
            ['Relative Airmass', '9.1%', 'Spectral effects & dust'],
            ['7-day Mean Humidity', '7.4%', 'Dust adhesion factor'],
            ['Wind Speed Mean', '6.8%', 'Deposition vs. removal'],
          ],
          caption: 'Table 2: Top ML features for soiling detection',
        },
      },
      {
        title: 'Transfer Learning Approach',
        level: 2,
        bulletPoints: [
          'Pre-training on 50+ GW public datasets (NREL PVDAQ, IEA PVPS Task 13)',
          'Zero-shot performance: 87-90% accuracy without site-specific training',
          'Fine-tuning strategy: 3-6 months to reach 94-97% accuracy',
          'Continuous learning with new cleaning events and rain data',
        ],
        callout: {
          type: 'success',
          title: 'Deployment Timeline',
          content: 'Immediate deployment at 87-90% accuracy, reaching 94-97% after 3-6 months of site-specific data collection.',
        },
      },
      {
        title: 'Cleaning Schedule Optimization',
        level: 1,
        content: 'The economic optimization model determines optimal cleaning timing based on soiling accumulation rates, energy prices, and cleaning costs. Exhaustive search algorithm tests 1-5 cleaning scenarios per year.',
        keyMetrics: [
          { label: 'Typical ROI', value: '767%', highlight: true },
          { label: 'Payback Period', value: '2.7 months', highlight: false },
          { label: 'Annual Savings', value: '€109K+', highlight: false },
          { label: 'Water Savings', value: '40-60%', highlight: false },
        ],
      },
      {
        title: 'Competitive Comparison',
        level: 1,
        table: {
          headers: ['Solution', 'Accuracy', 'CAPEX', 'Annual Cost'],
          rows: [
            ['Traditional PR Monitoring', '75-85%', '€0', '€500-1K'],
            ['Hardware Soiling Sensors', '98-99%', '€1.5-4.5K', '€200-500'],
            ['NuraVolt Physics-ML', '94-97%', '€0', '€650/MWp'],
          ],
          caption: 'Table 3: Competitive positioning analysis',
        },
        callout: {
          type: 'highlight',
          title: 'Key Advantage',
          content: 'NuraVolt achieves near-hardware accuracy at 50% lower total cost with no capital expenditure requirements.',
        },
      },
    ],
  }),

  // Comprehensive Fault Detection Whitepaper
  faultDetection: (): WhitepaperExportOptions => ({
    title: 'Fault Detection Technical Specification',
    subtitle: 'Predictive & Reactive Detection for Solar PV Systems',
    version: '2.0',
    includeCoverPage: true,
    includeTableOfContents: true,
    sections: [
      {
        title: 'Executive Summary',
        level: 1,
        content: 'This document provides precise specifications for solar PV fault detection, distinguishing between predictive faults (70-75% of failures, detectable 1-90 days in advance) and reactive faults (25-30%, instantaneous detection only).',
        keyMetrics: [
          { label: 'Detection Accuracy', value: '95%+', highlight: true },
          { label: 'Advance Warning', value: '2-15 days', highlight: false },
          { label: 'False Positive Rate', value: '<5%', highlight: false },
          { label: 'Data Points', value: '200+/MW', highlight: false },
        ],
      },
      {
        title: 'Validation Data Sources',
        level: 1,
        bulletPoints: [
          'NREL PVDAQ: 1,500+ systems, 10+ years, 10,000+ labeled fault events',
          'IEA PVPS Task 13: 50+ GW, standardized IEC 61724 fault taxonomy',
          'IEEE Dataport: 99.97% accuracy benchmarks on 36,543+ labeled samples',
          'Field validation: 500+ MW deployed systems (Spain, Netherlands, UAE)',
        ],
      },
      {
        title: 'Predictive Faults: Inverter Components',
        level: 1,
        content: '27% of all failures are predictable inverter faults. These follow gradual degradation patterns: capacitor ESR increase, IGBT thermal stress, cooling system wear, and control board issues.',
        table: {
          headers: ['Fault Type', 'Advance Warning', 'Accuracy', 'Detection Method'],
          rows: [
            ['Capacitor Failure', '5-15 days', '94-97%', 'ESR trending, efficiency decline'],
            ['IGBT Degradation', '3-10 days', '92-96%', 'Thermal & efficiency patterns'],
            ['Cooling System', '2-7 days', '90-94%', 'Fan duty cycle, cabinet temp'],
            ['Control Board', '1-5 days', '88-92%', 'Comm logs, error patterns'],
          ],
          caption: 'Table 1: Inverter fault prediction capabilities',
        },
      },
      {
        title: 'Predictive Faults: String-Level',
        level: 1,
        content: '10-12% of failures are predictable string faults with gradual degradation: connector corrosion, wire insulation degradation, bypass diode thermal issues, and junction box contact problems.',
        table: {
          headers: ['Fault Type', 'Advance Warning', 'Accuracy', 'Detection Signal'],
          rows: [
            ['Connector Corrosion', '5-14 days', '88-92%', 'CV increase trend'],
            ['Wire Degradation', '7-21 days', '85-90%', 'Resistance trending'],
            ['Bypass Diode', '3-14 days', '90-94%', 'Hot spot + string power'],
            ['Junction Box', '5-10 days', '85-90%', 'Contact resistance'],
          ],
          caption: 'Table 2: String fault prediction capabilities',
        },
      },
      {
        title: 'Reactive Faults (Real-Time Only)',
        level: 1,
        content: '25-30% of faults cannot be predicted due to instantaneous failure mechanisms: lightning strikes, grid surges, mechanical damage, open circuits, and fuse blows.',
        bulletPoints: [
          'Lightning/surge: Instantaneous destruction (milliseconds)',
          'Wire breakage: External triggers (animals, storms)',
          'Fuse blow: Overcurrent protection (milliseconds)',
          'Physical damage: Hail, projectiles, vandalism',
        ],
        callout: {
          type: 'warning',
          title: 'Detection Limitation',
          content: 'These faults have no degradation precursor pattern - only real-time detection is possible. NuraVolt alerts within seconds of occurrence.',
        },
      },
      {
        title: 'Digital Twin Advantages',
        level: 1,
        content: 'NuraVolt\'s digital twin approach provides significant advantages over traditional Performance Ratio (PR) monitoring through physics-informed ML and multi-signal analysis.',
        table: {
          headers: ['Capability', 'PR Monitoring', 'NuraVolt Digital Twin'],
          rows: [
            ['Data Points', '4-8 per MW', '200+ per MW'],
            ['Anomaly Detection', 'Manual threshold', 'Physics + ML baseline'],
            ['Root Cause', 'None', '70-85% classification'],
            ['Advance Warning', '0 days (reactive)', '2-15 days predictive'],
            ['False Positives', '70-85%', '<5%'],
          ],
          caption: 'Table 3: Digital twin vs PR monitoring comparison',
        },
      },
      {
        title: 'Field Validation Results',
        level: 1,
        keyMetrics: [
          { label: 'Spanish 120MW', value: '96.9%', highlight: true },
          { label: 'Dutch 85MW', value: '94.8%', highlight: false },
          { label: 'UAE 50MW', value: '95.3%', highlight: false },
          { label: 'Avg Advance Warning', value: '7 days', highlight: false },
        ],
        callout: {
          type: 'success',
          title: 'Performance Benchmark',
          content: '18-month validation across 500+ MW demonstrates consistent 94-97% detection accuracy with <5% false positive rate.',
        },
      },
    ],
  }),

  // Comprehensive Transfer Learning Whitepaper
  transferLearning: (): WhitepaperExportOptions => ({
    title: 'Transfer Learning & Predictive Maintenance',
    subtitle: 'AI-Powered Solar Operations with 50+ GW Pre-Training',
    version: '1.0',
    includeCoverPage: true,
    includeTableOfContents: true,
    sections: [
      {
        title: 'Executive Summary',
        level: 1,
        content: 'NuraVolt\'s transfer learning approach leverages the largest curated dataset in solar O&M (50+ GW, 10+ years, 15+ inverter OEMs) to enable immediate fault detection for new clients, eliminating the traditional 6-12 month cold-start period.',
        keyMetrics: [
          { label: 'Data Foundation', value: '50+ GW', highlight: true },
          { label: 'Historical Data', value: '10+ years', highlight: false },
          { label: 'Inverter OEMs', value: '15+', highlight: false },
          { label: 'Countries', value: '40+', highlight: false },
        ],
      },
      {
        title: 'Performance Comparison',
        level: 1,
        table: {
          headers: ['Metric', 'NuraVolt', 'Traditional ML', 'Rule-Based'],
          rows: [
            ['Deployment Time', '3-6 months', '12+ months', 'Immediate'],
            ['Detection Accuracy', '92-96%', '85-90%', '70-75%'],
            ['Advance Warning', '2-15 days', '0-3 days', '0 days'],
            ['False Positive Rate', '<5%', '10-15%', '70-85%'],
            ['Training Data Required', '10-20%', '100%', 'None'],
          ],
          caption: 'Table 1: Performance comparison by approach',
        },
      },
      {
        title: 'Public Dataset Sources',
        level: 1,
        bulletPoints: [
          'NREL PVDAQ: 1,500+ systems, 2010-present, labeled fault events',
          'IEA PVPS Task 13: 50+ GW, 30+ countries, IEC 61724 taxonomy',
          'IEEE PVEL-AD: 36,543 images, 99.97% accuracy benchmark',
          'Elia PV Belgium: 2,500+ systems, string fault focus',
          'Cyprus Dataset: Mediterranean soiling patterns',
          'Desert Knowledge AU: Australian arid climate validation',
        ],
      },
      {
        title: 'Three-Stage Pipeline',
        level: 1,
        content: 'The transfer learning methodology follows a three-stage process: pre-training on public data, domain adaptation during onboarding, and continuous learning during operations.',
        table: {
          headers: ['Stage', 'Duration', 'Accuracy', 'Process'],
          rows: [
            ['Pre-training', 'One-time', '92%', '50+ GW → Base model'],
            ['Domain Adaptation', '1-7 days', '85-90%', 'Client metadata → Fine-tune'],
            ['Continuous Learning', 'Ongoing', '92-96%', 'Labeled events → Production'],
          ],
          caption: 'Table 2: Transfer learning pipeline stages',
        },
      },
      {
        title: 'Data Quality Pipeline',
        level: 1,
        content: 'Four-stage validation ensures high-quality training data: sensor physics validation, consensus cross-validation, statistical outlier removal, and feature engineering.',
        table: {
          headers: ['Stage', 'Criteria', 'Data Retained'],
          rows: [
            ['Physics Validation', 'Irradiance 0-1200 W/m², Temp -40-80°C', '~92%'],
            ['Consensus Validation', '3+ sensor agreement, score >0.5', '~87%'],
            ['Outlier Removal', 'Validation score >0.7, IQR filtering', '~83%'],
            ['Feature Engineering', '200+ physics/temporal features', '~83%'],
          ],
          caption: 'Table 3: Data quality pipeline stages',
        },
        callout: {
          type: 'info',
          title: 'Quality Impact',
          content: 'Filtering removes ~17% of raw data, improving model accuracy by +8-12% and reducing false positives by -40%.',
        },
      },
      {
        title: 'Real-World Validation',
        level: 1,
        keyMetrics: [
          { label: 'Spanish 120MW', value: '96.9%', highlight: true },
          { label: 'Dutch 85MW', value: '94.8%', highlight: false },
          { label: 'UAE 50MW', value: '95.3%', highlight: false },
          { label: 'Multi-site 500MW', value: '95.8%', highlight: false },
        ],
        callout: {
          type: 'success',
          title: 'Industry-Leading Performance',
          content: 'NuraVolt achieves 94-97% accuracy vs industry-reported 90-95%, with 7-15 day advance warning vs 0-3 days.',
        },
      },
    ],
  }),

  // Forecasting Implementation Guide
  forecastingGuide: (): WhitepaperExportOptions => ({
    title: '365-Day Soiling Forecast System',
    subtitle: 'Physics-ML Hybrid Forecasting & Cleaning Optimization',
    version: '1.0',
    includeCoverPage: true,
    includeTableOfContents: true,
    sections: [
      {
        title: 'Executive Summary',
        level: 1,
        content: 'This guide documents NuraVolt\'s 365-day soiling forecast system combining physics-ML hybrid forecasting, financial impact analysis, and optimal cleaning schedule optimization.',
        keyMetrics: [
          { label: 'Forecast Horizon', value: '365 days', highlight: true },
          { label: 'Uncertainty (30d)', value: '±2%', highlight: false },
          { label: 'Uncertainty (365d)', value: '±8-12%', highlight: false },
          { label: 'Optimization', value: '1-5 cleanings', highlight: false },
        ],
      },
      {
        title: 'Physics Baseline',
        level: 1,
        content: 'The physics model provides the foundation for long-term forecasting with configurable soiling rates and seasonal modulation.',
        bulletPoints: [
          'Base soiling rate: 0.25%/day (configurable per climate)',
          'Seasonal modulation: 1.5x dry season (May-Sept), 0.5x wet (Oct-Apr)',
          'Rain cleaning: >10mm = up to 95% restoration',
          'Realistic SR constraints: 0.70-1.00 range',
        ],
      },
      {
        title: 'ML Corrections',
        level: 1,
        content: 'Machine learning refines physics predictions using historical patterns, weather data, and AOD (Aerosol Optical Depth) integration.',
        bulletPoints: [
          'Residual learning on physics predictions',
          'Monthly pattern adjustments',
          'Historical trend incorporation',
          'Reliable for ~90 days (then degrades to physics baseline)',
        ],
      },
      {
        title: 'Uncertainty Quantification',
        level: 1,
        table: {
          headers: ['Horizon', 'Uncertainty', 'Confidence'],
          rows: [
            ['Days 1-30', '±2%', '95% CI'],
            ['Days 31-90', '±3-5%', '95% CI'],
            ['Days 91-180', '±5-8%', '90% CI'],
            ['Days 181-365', '±8-12%', '85% CI'],
          ],
          caption: 'Table 1: Forecast uncertainty by horizon',
        },
      },
      {
        title: 'Cleaning Schedule Optimizer',
        level: 1,
        content: 'Exhaustive search algorithm finds optimal cleaning dates by testing all combinations and ranking by net financial benefit.',
        bulletPoints: [
          'Generate candidates: Every 7 days (52/year), filter rainy periods',
          'Weight summer months 1.5x for higher energy value',
          'Test 1-5 cleaning scenarios with combinatorial search',
          'Rank by ROI and net benefit',
        ],
        keyMetrics: [
          { label: 'Typical ROI', value: '1013%', highlight: true },
          { label: 'Energy Recovered', value: '1850 MWh', highlight: false },
          { label: 'Net Benefit', value: '€109K', highlight: false },
          { label: 'Cleaning Reduction', value: '10 fewer', highlight: false },
        ],
      },
      {
        title: 'Financial Forecasting',
        level: 1,
        content: 'Complete financial modeling from soiling forecast to revenue impact projections.',
        bulletPoints: [
          'Monthly sun hours extraction from historical data',
          'Energy production with/without soiling losses',
          'Revenue impact at PPA rate (€65/MWh default)',
          'Cleaning ROI and payback period calculation',
        ],
        callout: {
          type: 'success',
          title: 'Example Result',
          content: 'Spanish 120MW: 2 optimized cleanings vs 12 baseline → €109K net benefit, 1013% ROI',
        },
      },
    ],
  }),

  // Digital Twin Configuration Guide
  digitalTwinGuide: (): WhitepaperExportOptions => ({
    title: 'Digital Twin Configuration Guide',
    subtitle: 'Complete Reference for Model Tuning & Experimentation',
    version: '1.0',
    includeCoverPage: true,
    includeTableOfContents: true,
    sections: [
      {
        title: 'Overview',
        level: 1,
        content: 'This guide provides complete configuration reference for NuraVolt digital twin models, including feature engineering, hyperparameter tuning, and quality thresholds.',
        keyMetrics: [
          { label: 'Total Features', value: '11', highlight: false },
          { label: 'Default R² Target', value: '0.70+', highlight: true },
          { label: 'Max MAE', value: '50 kW', highlight: false },
          { label: 'Parallel Workers', value: '4', highlight: false },
        ],
      },
      {
        title: 'Feature Categories',
        level: 1,
        content: 'Digital twin models use 11 features across four categories for accurate power prediction.',
        table: {
          headers: ['Category', 'Features', 'Purpose'],
          rows: [
            ['Core', 'irradiance, ambient_temp, module_temp', 'Primary inputs'],
            ['Temporal', 'day_of_year, hour_of_day, month', 'Seasonal patterns'],
            ['Solar Geometry', 'solar_elevation, solar_azimuth, air_mass', 'Sun position'],
            ['Derived', 'clearness_index, temp_delta', 'Environmental'],
          ],
          caption: 'Table 1: Feature categories for digital twin models',
        },
      },
      {
        title: 'Data Filtering Parameters',
        level: 1,
        content: 'Controls what historical data is used for training. Balance data quality vs quantity.',
        table: {
          headers: ['Parameter', 'Default', 'Trial Suggestions'],
          rows: [
            ['MAX_YEARS', '3.0', '2.0, 2.5, 3.5'],
            ['MIN_PR', '0.10', '0.05 (more data), 0.15 (higher quality)'],
            ['MIN_IRRADIANCE', '50.0 W/m²', '25 (include more), 100 (exclude cloudy)'],
            ['VALIDATION_SPLIT', '0.2', '0.15, 0.25'],
          ],
          caption: 'Table 2: Data filtering configuration',
        },
      },
      {
        title: 'CatBoost Hyperparameters',
        level: 1,
        content: 'Core gradient boosting model parameters controlling learning behavior and complexity.',
        table: {
          headers: ['Parameter', 'Default', 'Impact'],
          rows: [
            ['ITERATIONS', '1000', 'More learning, longer training'],
            ['LEARNING_RATE', '0.05', 'Lower = more stable'],
            ['DEPTH', '6', 'Higher = more complex'],
            ['L2_LEAF_REG', '3', 'Higher = less overfitting'],
            ['EARLY_STOPPING', '100', 'Prevents overtraining'],
          ],
          caption: 'Table 3: CatBoost hyperparameter reference',
        },
      },
      {
        title: 'Performance Impact Matrix',
        level: 1,
        table: {
          headers: ['Change', 'Training Time', 'Accuracy', 'Overfitting Risk'],
          rows: [
            ['↑ MAX_YEARS', '↑ Longer', '↑ Better', '↓ Lower'],
            ['↑ MIN_PR', '↓ Shorter', '↑ Better', '↑ Higher'],
            ['↑ ITERATIONS', '↑ Longer', '↑ Better', '↑ Higher'],
            ['↑ LEARNING_RATE', '↓ Shorter', '≈ Variable', '↑ Higher'],
            ['↑ DEPTH', '↑ Longer', '↑ Better', '↑ Higher'],
          ],
          caption: 'Table 4: Parameter change impact analysis',
        },
        callout: {
          type: 'info',
          title: 'Tuning Strategy',
          content: 'Start with defaults, then adjust one parameter at a time. Use --limit 5 --digital-twins-only for quick trials.',
        },
      },
      {
        title: 'Quality Thresholds',
        level: 1,
        content: 'Models must meet minimum quality criteria to be accepted for production use.',
        bulletPoints: [
          'Minimum R² score: 0.70 (default), try 0.60-0.80',
          'Maximum MAE: 50 kW (default), try 30-75 kW',
          'Minimum training samples: 500 per inverter',
          'Validation split: 20% holdout for testing',
        ],
        callout: {
          type: 'warning',
          title: 'Production Deployment',
          content: 'Only models meeting both R² and MAE thresholds are deployed. Failed models trigger alerts for manual review.',
        },
      },
    ],
  }),

  // Legacy templates for backwards compatibility
  accuracyMetrics: (): WhitepaperExportOptions => ({
    title: 'Soiling Detection Accuracy Metrics & Validation Data',
    subtitle: 'Field deployment validation demonstrating 94-97% detection accuracy',
    version: '1.0',
    includeCoverPage: true,
    includeTableOfContents: true,
    sections: [
      {
        title: 'Executive Summary',
        level: 1,
        content: 'This document provides comprehensive validation data from three field deployments demonstrating 94-97% soiling detection accuracy and 88-92% forecast accuracy (7-day horizon).',
        keyMetrics: [
          { label: 'Detection Accuracy', value: '96.3%', highlight: true },
          { label: 'Cost Reduction', value: '32%', highlight: false },
          { label: 'Payback Period', value: '6 months', highlight: false },
          { label: 'Advance Warning', value: '7-10 days', highlight: false },
        ],
      },
      {
        title: 'Spanish 120 MW Deployment',
        level: 1,
        content: 'Andalusia, Spain - 18-month validation period with 24 cleaning events.',
        table: {
          headers: ['Metric', 'Value', 'Validation Method'],
          rows: [
            ['True Positives', '23 / 24', 'Manual cleaning logs'],
            ['False Positives', '4 / 131', 'Human review, no action'],
            ['Detection Accuracy', '96.3%', '(TP + TN) / Total'],
            ['F1 Score', '90.2%', 'Precision × Recall'],
          ],
          caption: 'Table 1: Detection accuracy results (18 months)',
        },
      },
      {
        title: 'Competitive Comparison',
        level: 1,
        bulletPoints: [
          'Traditional PR monitoring: 75-85% accuracy, 15-25% false positive rate',
          'Hardware soiling sensors: 98-99% accuracy, €1,500-4,500 capex',
          'NuraVolt physics-ML hybrid: 94-97% accuracy, software-only (no capex)',
        ],
        callout: {
          type: 'highlight',
          title: 'Key Advantage',
          content: 'NuraVolt achieves near-hardware accuracy at 50% lower cost with no capital expenditure requirements.',
        },
      },
    ],
  }),
};

export default WhitepaperPdfGenerator;
