// Generic puppeteer page → PDF renderer.
// Usage: node scripts/render_page_to_pdf.mjs <url> <output-path> [footer-left]
//
// Used by:
//   - scripts/render_compliance_pdf.mjs (wraps this with compliance-specific config)
//   - /api/dashboards/[id]/export-pdf (server-side spawns this to convert a
//     dashboard's public share URL into a PDF).
import puppeteer from 'puppeteer';
import path from 'node:path';

const [, , urlArg, outArg, footerLeft = 'ShamsIQ'] = process.argv;
if (!urlArg || !outArg) {
  console.error(
    'Usage: node scripts/render_page_to_pdf.mjs <url> <output-path> [footer-left]',
  );
  process.exit(1);
}
const OUT = path.resolve(outArg);

const browser = await puppeteer.launch({ headless: 'new' });
try {
  const page = await browser.newPage();
  // Wide viewport so dashboard grids lay out at their full width before
  // print. 1400 matches the editor page container.
  await page.setViewport({ width: 1400, height: 1600, deviceScaleFactor: 2 });

  // The render is cookieless; org-owned plants' widget fetches would fail
  // tenancy checks. The caller passes the internal API secret so the pages'
  // data requests carry the internal-tool header (accepted by
  // resolvePlantForRead).
  const internalSecret = process.env.INTERNAL_RENDER_HEADER_SECRET;
  if (internalSecret) {
    await page.setExtraHTTPHeaders({ 'x-internal-chat-tool': internalSecret });
  }

  console.log(`Navigating to ${urlArg}`);
  await page.goto(urlArg, { waitUntil: 'networkidle0', timeout: 90_000 });

  // Dashboards load widget data asynchronously post-networkidle; give them a
  // moment to paint. Also collapse any "no-drag/no-print" chrome.
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''));
    document.querySelectorAll('.no-print').forEach((el) => {
      el.style.display = 'none';
    });
  });

  await page.emulateMediaType('print');

  await page.pdf({
    path: OUT,
    format: 'A4',
    landscape: true,
    printBackground: true,
    margin: { top: '12mm', bottom: '14mm', left: '12mm', right: '12mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      '<div style="width:100%;font-size:9px;color:#6b7280;padding:0 12mm;display:flex;justify-content:space-between;">' +
      `<span>${footerLeft.replace(/</g, '&lt;')}</span>` +
      '<span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>' +
      '</div>',
  });
  console.log(`Wrote ${OUT}`);
} finally {
  await browser.close();
}
