/**
 * PDF Generation Script
 * Converts HTML whitepaper/checklist content to PDF files
 *
 * Usage: node scripts/generate-pdfs.js
 * Requires: npm install --save-dev puppeteer
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const resources = [
  {
    slug: 'irradiation-data-quality',
    htmlFile: 'irradiation-data-quality.html',
    pdfFile: 'irradiation-data-quality.pdf'
  },
  {
    slug: 'inverter-failures-detection',
    htmlFile: 'inverter-failures-detection.html',
    pdfFile: 'inverter-failures-detection.pdf'
  },
  {
    slug: 'bess-thermal-runaway',
    htmlFile: 'bess-thermal-runaway.html',
    pdfFile: 'bess-thermal-runaway.pdf'
  },
  {
    slug: 'pv-data-checklist',
    htmlFile: 'pv-data-checklist.html',
    pdfFile: 'pv-data-checklist.pdf'
  },
  {
    slug: 'inverter-checklist',
    htmlFile: 'inverter-checklist.html',
    pdfFile: 'inverter-checklist.pdf'
  },
  {
    slug: 'bess-checklist',
    htmlFile: 'bess-checklist.html',
    pdfFile: 'bess-checklist.pdf'
  }
];

async function generatePDFs() {
  console.log('🚀 Starting PDF generation...\n');

  // Create output directory if it doesn't exist
  const outputDir = path.join(__dirname, '../public/resources/pdfs');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log('📁 Created output directory:', outputDir);
  }

  // Launch browser
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  console.log('🌐 Browser launched\n');

  for (const resource of resources) {
    try {
      console.log(`📄 Generating: ${resource.slug}...`);

      const htmlPath = path.join(__dirname, '../public/resources/content', resource.htmlFile);
      const pdfPath = path.join(outputDir, resource.pdfFile);

      // Check if HTML file exists
      if (!fs.existsSync(htmlPath)) {
        console.error(`  ❌ HTML file not found: ${htmlPath}`);
        continue;
      }

      // Create new page
      const page = await browser.newPage();

      // Load HTML file
      const htmlContent = fs.readFileSync(htmlPath, 'utf8');
      await page.setContent(htmlContent, {
        waitUntil: 'networkidle0'
      });

      // Generate PDF with print-optimized settings
      await page.pdf({
        path: pdfPath,
        format: 'A4',
        printBackground: true,
        margin: {
          top: '2cm',
          right: '2cm',
          bottom: '2cm',
          left: '2cm'
        },
        displayHeaderFooter: false
      });

      await page.close();

      // Get file size
      const stats = fs.statSync(pdfPath);
      const fileSizeInKB = (stats.size / 1024).toFixed(2);

      console.log(`  ✅ Generated: ${resource.pdfFile} (${fileSizeInKB} KB)`);

    } catch (error) {
      console.error(`  ❌ Error generating ${resource.slug}:`, error.message);
    }
  }

  await browser.close();

  console.log('\n✨ PDF generation complete!');
  console.log(`📂 Output directory: ${outputDir}\n`);
}

// Run the script
generatePDFs().catch(error => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});
