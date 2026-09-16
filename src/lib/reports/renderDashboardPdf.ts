import prisma from '@/libs/prisma';
import { renderPageToPdf } from '@/lib/reports/renderPageToPdf';

/**
 * Render a dashboard's public share page to a PDF buffer via headless
 * Chrome (renderPageToPdf — full puppeteer locally, @sparticuz/chromium on
 * Vercel). If the dashboard is private, a transient 5-minute share token is
 * minted for the render and revoked after.
 *
 * The renderer injects INTERNAL_API_SECRET as the x-internal-chat-tool
 * header on every page request, so org-owned plants' widget fetches pass
 * resolvePlantForRead — without it the cookieless render produced
 * data-empty PDFs for real orgs.
 *
 * Callers should still catch: a Chrome failure anywhere degrades to the
 * org-aware section PDF (cron, send, generate all do).
 */
export async function renderDashboardPdf(
  dashboard: { id: string; title: string; share_token: string | null; share_expires_at: Date | null },
  baseUrl: string
): Promise<Buffer> {
  const wasPrivate = !dashboard.share_token;
  const token = dashboard.share_token ?? mintToken();
  const expires = new Date(Date.now() + 5 * 60_000);

  await prisma.dashboard.update({
    where: { id: dashboard.id },
    data: {
      share_token: token,
      share_expires_at: wasPrivate ? expires : dashboard.share_expires_at,
    },
  });

  try {
    return await renderPageToPdf(`${baseUrl}/r/${token}`, `NuraVolt · ${dashboard.title}`);
  } finally {
    if (wasPrivate) {
      await prisma.dashboard
        .update({
          where: { id: dashboard.id },
          data: { share_token: null, share_expires_at: null },
        })
        .catch(() => {});
    }
  }
}

function mintToken(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let t = '';
  for (let i = 0; i < 22; i++) t += alphabet[Math.floor(Math.random() * alphabet.length)];
  return t;
}
