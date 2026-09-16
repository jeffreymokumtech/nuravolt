/**
 * In-process page → PDF renderer (the serverless-capable sibling of
 * scripts/render_page_to_pdf.mjs, which needs a local Chrome and a child
 * process — neither exists on Vercel).
 *
 * Browser factory:
 * - Vercel / Lambda: puppeteer-core + @sparticuz/chromium (the Brotli-packed
 *   binary ships in the function bundle and extracts to /tmp on first use).
 * - Local dev: full puppeteer (devDependency) with its downloaded Chrome.
 *
 * Both packages are lazily imported so neither is bundled into routes that
 * never render PDFs; next.config.js marks them external for the server build.
 */

type PuppeteerLikeBrowser = {
  newPage(): Promise<any>;
  close(): Promise<void>;
};

async function launchBrowser(): Promise<PuppeteerLikeBrowser> {
  const onServerless = Boolean(
    process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
  );
  if (onServerless) {
    const [{ default: chromium }, puppeteer] = await Promise.all([
      import('@sparticuz/chromium'),
      import('puppeteer-core'),
    ]);
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    }) as unknown as PuppeteerLikeBrowser;
  }
  const puppeteer = await import('puppeteer');
  return puppeteer.launch({ headless: true }) as unknown as PuppeteerLikeBrowser;
}

export async function renderPageToPdf(
  url: string,
  footerLeft = 'NuraVolt'
): Promise<Buffer> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    // Wide viewport so dashboard grids lay out at their full width before
    // print. 1400 matches the editor page container.
    await page.setViewport({ width: 1400, height: 1600, deviceScaleFactor: 2 });

    // The render is cookieless; org-owned plants' widget fetches would fail
    // tenancy checks without the internal-tool header (accepted by
    // resolvePlantForRead).
    const internalSecret = process.env.INTERNAL_API_SECRET;
    if (internalSecret) {
      await page.setExtraHTTPHeaders({ 'x-internal-chat-tool': internalSecret });
    }

    await page.goto(url, { waitUntil: 'networkidle0', timeout: 90_000 });

    // Dashboards load widget data asynchronously post-networkidle; give them
    // a moment to paint, then collapse no-print chrome.
    await new Promise((r) => setTimeout(r, 1500));
    await page.evaluate(() => {
      document.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''));
      document.querySelectorAll<HTMLElement>('.no-print').forEach((el) => {
        el.style.display = 'none';
      });
    });

    await page.emulateMediaType('print');

    const pdf: Uint8Array = await page.pdf({
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
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch(() => {});
  }
}
