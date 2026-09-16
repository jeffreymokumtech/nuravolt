/**
 * Idempotent seeder for the Copilot knowledge base.
 *
 * Walks public/data/manuals/seed/, embeds every supported file via the
 * existing ingestKBDocument() pipeline (Bedrock Titan v2 + pgvector), and
 * upserts into KBDocument under the demo org. Re-running is safe — the
 * underlying ingest skips any file whose SHA-256 already exists in the
 * org's KBDocument table.
 *
 * Usage:
 *   npm run seed:manuals
 *   npm run seed:manuals -- --org=org_abc123    # override target org
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Preserve an explicitly provided DATABASE_URL (e.g. seeding prod with
// `DATABASE_URL=$PROD npx tsx scripts/seed_manuals.ts --org=global`), but
// keep `override: true` for everything else so an expired
// AWS_BEARER_TOKEN_BEDROCK in the calling shell doesn't shadow the working
// value in .env.
const explicitDatabaseUrl = process.env.DATABASE_URL;
// An explicitly-exported DATABASE_URL always beats .env. Overriding
// unconditionally sent a prod-targeted run to the local database and it
// reported "no organization matched" against the wrong data entirely.
dotenv.config({ override: !process.env.DATABASE_URL });
if (explicitDatabaseUrl) process.env.DATABASE_URL = explicitDatabaseUrl;

import crypto from 'crypto';
import prisma from '../src/libs/prisma';
import { ingestKBDocument, SUPPORTED_FILE_TYPES, type SupportedFileType } from '../src/lib/ai/kb-ingest';

interface Frontmatter {
  title?: string;
  equipment_type?: string;
  manufacturer?: string;
  model_number?: string;
  synthetic?: boolean;
}

const SEED_ROOT = path.resolve(__dirname, '..', 'public/data/manuals/seed');
const DEFAULT_ORG = process.env.SEED_MANUALS_ORG ?? 'demo_org_alpha1';
const DEFAULT_UPLOADER = 'seed_script';

/** Pulled out so callers can override the org via CLI for staging fleets.
 *  `--org=global` seeds as shared documents (org_clerk_id NULL) — public
 *  vendor manuals every org may read. */
function parseArgs(): { org: string | null } {
  let org: string | null = DEFAULT_ORG;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--org=')) {
      const v = arg.slice('--org='.length);
      org = v === 'global' ? null : v;
    }
  }
  return { org };
}

/** Skip README and dotfiles so accidental notes don't get embedded. */
function shouldSeed(filename: string): boolean {
  if (filename.startsWith('.') || filename.startsWith('_')) return false;
  if (filename.toLowerCase() === 'readme.md') return false;
  return true;
}

function walkSync(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!shouldSeed(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSync(full, acc);
    else if (entry.isFile()) acc.push(full);
  }
  return acc;
}

function extOf(filename: string): SupportedFileType | null {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return (SUPPORTED_FILE_TYPES as readonly string[]).includes(ext)
    ? (ext as SupportedFileType)
    : null;
}

/** Lightweight YAML-frontmatter parser for `.md` / `.txt` files. */
function readFrontmatter(filePath: string, fileType: SupportedFileType): Frontmatter {
  if (fileType !== 'md' && fileType !== 'txt') return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = raw.slice(3, end).trim();
  const out: Frontmatter = {};
  for (const line of block.split('\n')) {
    const eq = line.indexOf(':');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k === 'synthetic') (out as any)[k] = v === 'true';
    else (out as any)[k] = v;
  }
  return out;
}

function inferFromOemFilename(filename: string): Pick<Frontmatter, 'equipment_type' | 'manufacturer' | 'model_number' | 'title'> {
  const base = path.basename(filename, path.extname(filename));
  const lower = base.toLowerCase();
  if (lower.includes('sun2000')) {
    const model = base.replace(/-datasheet$/i, '');
    return { equipment_type: 'inverter', manufacturer: 'Huawei', model_number: model, title: `${model} datasheet` };
  }
  if (lower.includes('byd') && lower.includes('battery-box')) {
    return { equipment_type: 'battery', manufacturer: 'BYD', model_number: 'Battery-Box Premium HVS/HVM', title: 'BYD Battery-Box Premium HVS/HVM datasheet' };
  }
  if (lower.includes('tesla') && lower.includes('powerwall')) {
    return { equipment_type: 'battery', manufacturer: 'Tesla', model_number: 'Powerwall 3', title: 'Tesla Powerwall 3 datasheet' };
  }
  if (lower.includes('trina') && lower.includes('vertex')) {
    return { equipment_type: 'pv_module', manufacturer: 'Trina Solar', model_number: 'Vertex N TSM-NEG21C.20', title: 'Trina Vertex N (NEG21C.20, 695-720W) datasheet' };
  }
  return { title: base };
}

async function main() {
  const { org } = parseArgs();

  const files = walkSync(SEED_ROOT).filter((f) => extOf(f) !== null);
  if (!files.length) {
    console.log(`No supported files under ${SEED_ROOT}`);
    return;
  }

  console.log(`Seeding ${files.length} files into org ${org}…`);
  let created = 0, skipped = 0, failed = 0;

  for (const filePath of files) {
    const fileType = extOf(filePath)!;
    const fileName = path.basename(filePath);
    const isOem = filePath.includes(path.sep + 'oem' + path.sep);
    const fm = isOem ? inferFromOemFilename(fileName) : readFrontmatter(filePath, fileType);
    const title = fm.title ?? path.basename(fileName, path.extname(fileName));

    try {
      const buffer = fs.readFileSync(filePath);

      // Heal previous failed/processing rows so we can retry cleanly. The
      // ingest pipeline dedups by file_hash, so a stuck row would otherwise
      // shadow a real retry.
      const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
      await prisma.kBDocument.deleteMany({
        where: {
          org_clerk_id: org,
          file_hash: fileHash,
          processing_status: { in: ['failed', 'processing'] },
        },
      });

      const result = await ingestKBDocument({
        orgClerkId: org,
        uploadedBy: DEFAULT_UPLOADER,
        title,
        fileName,
        fileType,
        buffer,
        plantId: null,
        equipmentType: fm.equipment_type ?? null,
        manufacturer: fm.manufacturer ?? null,
        modelNumber: fm.model_number ?? null,
      });
      if (result.duplicate) {
        skipped += 1;
        console.log(`  · skip   ${fileName}  (already indexed)`);
      } else {
        created += 1;
        console.log(`  ✓ embed  ${fileName}  → ${result.document.chunk_count} chunks`);
      }
    } catch (e) {
      failed += 1;
      const msg = (e as Error).message;
      console.error(`  ✗ fail   ${fileName}: ${msg}`);
      if (msg.toLowerCase().includes('authentication failed') || msg.toLowerCase().includes('api key')) {
        console.error('         → Bedrock auth failed. Check AWS_BEARER_TOKEN_BEDROCK in .env;');
        console.error('           refresh via your AWS console / `aws bedrock create-api-key`.');
      }
    }
  }

  console.log(`\nDone. created=${created} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
