/**
 * Seed historical Shams conversations into an org's chat sidebar so the
 * account feels lived-in for demos.
 *
 *   npx tsx scripts/seed_demo_conversations.ts --org=<org_clerk_id> --user=<user_id> \
 *     [--plant=<target-slug>] [--wipe]
 *
 * Content = the ribera example-session fixtures (src/fixtures/demo-conversations)
 * with plant references retargeted to the org's real plant slug (default
 * ribera-solar) so cite chips and table links resolve on /dashboard. Rows are
 * back-dated over the past three weeks and use ids prefixed `seed-conv-` so
 * re-runs and --wipe are precise.
 *
 * Note: draft cards inside seeded conversations are LIVE (no scripted-thread
 * context) — pressing Create/Schedule really persists in the owner's account.
 * That is intended: it demos the confirm loop on real controls.
 *
 * Also archives empty "New conversation" rows for the target user.
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local' });

import { PrismaClient } from '@prisma/client';
import riberaThreads from '../src/fixtures/demo-conversations/ribera';
import type { DemoThread } from '../src/fixtures/demo-conversations/types';

const prisma = new PrismaClient();

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
}
const WIPE = process.argv.includes('--wipe');

/**
 * Retarget plant slug references inside serialized message parts. Exact
 * token replacements only — never a bare substring replace, so re-running
 * against an already-retargeted payload is a no-op.
 */
function retargetParts(
  parts: unknown,
  from: string,
  to: string,
  fromName?: string,
  toName?: string
): unknown {
  let s = JSON.stringify(parts);
  const rules: Array<[string, string]> = [
    [`plant=${from}|`, `plant=${to}|`],
    [`plant=${from}]]`, `plant=${to}]]`],
    [`"slug":"${from}"`, `"slug":"${to}"`],
    [`"plant_id":"${from}"`, `"plant_id":"${to}"`],
    [`"plant_slug":"${from}"`, `"plant_slug":"${to}"`],
    [`"plantId":"${from}"`, `"plantId":"${to}"`],
    [`"id":"${from}"`, `"id":"${to}"`],
    // Display text: bare slug mentions plus the plant's human name — a
    // demo org's history must not read as another operator's plant.
    [from, to],
  ];
  if (fromName && toName && fromName !== toName) {
    rules.push([fromName, toName]);
    // Common short form ("Ribera" without the suffix) — word-ish token only.
    const shortFrom = fromName.split(' ')[0];
    const shortTo = toName.split(' ')[0];
    if (shortFrom.length > 3 && shortFrom !== shortTo) {
      rules.push([`${shortFrom} `, `${shortTo} `], [`${shortFrom}'`, `${shortTo}'`], [`${shortFrom}.`, `${shortTo}.`], [`${shortFrom},`, `${shortTo},`]);
    }
  }
  for (const [a, b] of rules) s = s.split(a).join(b);
  return JSON.parse(s);
}

function extractText(parts: any[]): string {
  return (parts ?? [])
    .filter((p) => p?.type === 'text')
    .map((p) => p.text as string)
    .join('\n')
    .trim();
}

async function main() {
  const org = arg('org');
  const user = arg('user');
  const targetSlug = arg('plant') ?? 'ribera-solar';
  // Conversation ids are fixed strings; seeding a SECOND org on the same
  // database needs a distinguishing suffix or every row reads "exists".
  const idSuffix = arg('suffix') ? `-${arg('suffix')}` : '';
  if (!org || !user) {
    console.error('Usage: --org=<org_clerk_id> --user=<user_id> [--plant=<slug>] [--suffix=<org-tag>] [--wipe]');
    process.exit(1);
  }

  if (WIPE) {
    const gone = await prisma.conversation.deleteMany({
      where: { org_clerk_id: org, id: { startsWith: 'seed-conv-' } },
    });
    console.log(`Wiped ${gone.count} previously seeded conversations.`);
  }

  // Human name for display-text retargeting (fixture threads narrate about
  // "Ribera Solar Park"; the seeded copies must speak about the target).
  const targetPlant = await prisma.plant.findFirst({ where: { slug: targetSlug } });
  const targetName = targetPlant?.name ?? targetSlug;

  // Back-date spread (days ago) per thread, most recent first in the
  // sidebar. The cleaning + irradiance threads quote analyses generated in
  // December 2025 (the fixture era), so they are dated back to that window
  // to stay internally coherent; the date-free threads read as recent.
  const threads: Array<{ thread: DemoThread; daysAgo: number }> = [
    { thread: riberaThreads.find((t) => t.id === 'ribera-fault-triage')!, daysAgo: 2 },
    { thread: riberaThreads.find((t) => t.id === 'ribera-manuals-sop')!, daysAgo: 9 },
    { thread: riberaThreads.find((t) => t.id === 'ribera-weekly-report')!, daysAgo: 18 },
    { thread: riberaThreads.find((t) => t.id === 'ribera-irradiance-quality')!, daysAgo: 213 },
    { thread: riberaThreads.find((t) => t.id === 'ribera-cleaning-roi')!, daysAgo: 215 },
  ].filter((x) => x.thread);

  let created = 0;
  for (const { thread, daysAgo } of threads) {
    const convId = `seed-conv-${thread.id}${idSuffix}`;
    const at = new Date(Date.now() - daysAgo * 24 * 3600 * 1000);

    const existing = await prisma.conversation.findUnique({ where: { id: convId } });
    if (existing) {
      console.log(`skip (exists): ${convId}`);
      continue;
    }

    await prisma.conversation.create({
      data: {
        id: convId,
        org_clerk_id: org,
        user_clerk_id: user,
        title: thread.prompt.slice(0, 60),
        plant_id: targetSlug,
        system_prompt_version: 'v9',
        created_at: at,
        updated_at: at,
      },
    });

    let offsetMs = 0;
    for (const msg of thread.messages) {
      const parts = retargetParts(
        msg.parts,
        thread.plantSlug,
        targetSlug,
        'Ribera Solar Park',
        targetName
      ) as any[];
      await prisma.chatMessage.create({
        data: {
          conversation_id: convId,
          role: msg.role === 'user' ? 'USER' : 'ASSISTANT',
          content: extractText(parts) || '(tool output)',
          parts: parts as object,
          created_at: new Date(at.getTime() + offsetMs),
        },
      });
      offsetMs += 20_000;
    }
    created++;
    console.log(`seeded: ${convId} (${daysAgo}d ago) → plant ${targetSlug}`);
  }

  // Tidy: archive empty "New conversation" rows for this user.
  const empties = await prisma.conversation.findMany({
    where: {
      org_clerk_id: org,
      user_clerk_id: user,
      title: 'New conversation',
      archived: false,
      messages: { none: {} },
    },
    select: { id: true },
  });
  if (empties.length) {
    await prisma.conversation.updateMany({
      where: { id: { in: empties.map((e) => e.id) } },
      data: { archived: true },
    });
    console.log(`archived ${empties.length} empty "New conversation" row(s).`);
  }

  console.log(`Done. created=${created}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
