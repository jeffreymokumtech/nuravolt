// Render /compliance/reference to a PDF using puppeteer.
// Usage: node scripts/render_compliance_pdf.mjs [output-path]
import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const URL = process.env.COMPLIANCE_URL || 'http://localhost:3000/compliance/reference';
const OUT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'public', 'data', 'compliance_reference.pdf');

const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();
// Use a wide-ish viewport so SVGs lay out nicely before print.
await page.setViewport({ width: 1100, height: 1400, deviceScaleFactor: 2 });

console.log(`Navigating to ${URL}`);
await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60_000 });

// Expand the <details> so the full glossary is included in the PDF.
await page.evaluate(() => {
  document.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''));
});

// Switch to print emulation so our @media print CSS applies (page-breaks etc).
await page.emulateMediaType('print');

await page.pdf({
  path: OUT,
  format: 'A4',
  printBackground: true,
  margin: { top: '12mm', bottom: '14mm', left: '12mm', right: '12mm' },
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="width:100%;font-size:9px;color:#6b7280;padding:0 12mm;display:flex;justify-content:space-between;">' +
    '<span>ShamsIQ · Compliance Reference Guide</span>' +
    '<span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>' +
    '</div>',
});

await browser.close();
console.log(`Wrote ${OUT}`);
