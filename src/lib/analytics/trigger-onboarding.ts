import prisma from '@/libs/prisma';

/**
 * Fire-and-forget trigger for the plant-onboarding analytics workflow.
 *
 * Creates a queued AnalyticsJob row (so the status page shows progress
 * immediately) and dispatches .github/workflows/plant-onboarding.yml via the
 * GitHub REST API. Requires:
 *  - GITHUB_DISPATCH_TOKEN — fine-grained PAT with Actions read/write on the repo
 *  - GITHUB_REPO           — e.g. "jeffreymokumtech/nuravolt"
 *
 * Never throws: plant creation must succeed even when the dispatch fails
 * (the nightly sweep picks up plants whose onboarding never ran).
 */
export async function triggerPlantOnboarding(plantId: string): Promise<void> {
  let jobId: string | null = null;
  try {
    const job = await prisma.analyticsJob.create({
      data: { plant_id: plantId, job_type: 'onboarding', status: 'queued' },
    });
    jobId = job.id;
  } catch (e) {
    console.error('[analytics] failed to create AnalyticsJob row:', e);
  }

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    console.warn(
      '[analytics] GITHUB_DISPATCH_TOKEN / GITHUB_REPO not set — onboarding job stays queued for the nightly sweep'
    );
    return;
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/plant-onboarding.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: { plant_id: plantId, job_id: jobId ?? '' },
        }),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[analytics] workflow dispatch failed (${res.status}): ${body.slice(0, 300)}`);
    }
  } catch (e) {
    console.error('[analytics] workflow dispatch error:', e);
  }
}
