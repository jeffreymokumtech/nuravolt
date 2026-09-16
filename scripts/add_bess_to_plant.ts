/**
 * Attach a battery to an existing plant, so a PV site becomes a co-located
 * hybrid and the battery section appears for it.
 *
 *   npx tsx scripts/add_bess_to_plant.ts --plant ribera --power-mw 5 --energy-mwh 10
 *
 * What it changes:
 *   - Plant.asset_type PV -> HYBRID (a plant already BESS or HYBRID is left as is)
 *   - Plant.energy_capacity_mwh, which the equivalent-MW pricing meter reads
 *   - creates or updates one BessAsset
 *   - creates one BessWarrantyTerms row when that asset has none
 *   - Plant.country only when --country is passed and the column is empty
 *
 * Why asset_type matters: the battery nav keys off it via assetTypeChip() ->
 * navForAssetChip(), so without HYBRID the section never renders. HYBRID keeps
 * has_pv true in onboard_plant.py, so the existing PV analytics are untouched;
 * it additionally turns on has_bess, which lets the nightly build the
 * provisional dispatch twin over real day-ahead prices for the plant's zone.
 *
 * Why warranty terms are written here: BessWarrantyTerms is the numeric source
 * of truth for the warranty guardian (the 4-axis tracker, the violation
 * detector, the dossier). An asset without a terms row renders "warranty status
 * unavailable" on every one of those surfaces, so a battery created through
 * this path used to be born with a quarter of the product dead.
 *
 * Honesty, three times over:
 *   1. The BessAsset row is a DECLARED NAMEPLATE, not a commissioning record,
 *      and no BMS is connected. metadata.declared_nameplate marks it so the
 *      provisional labelling downstream stays truthful.
 *   1b. installation_date is never "today". Today is when the row was typed,
 *      not when the battery was installed, and stamping it there produced an
 *      asset whose own dispatch history ran back a year before it existed,
 *      with the console rendering a calendar age off one date and a
 *      commissioning date off another. resolveInstallationDate() picks the
 *      best evidence available and records which it used in
 *      metadata.installation_date_source; with no evidence the column stays
 *      null so the UI can render it absent. The Python twin
 *      (nuravolt/pipeline/bess_intelligence.py resolve_installation_date)
 *      applies the same precedence, so the two writers converge.
 *   2. Warranty limits not passed on the command line are CHEMISTRY DEFAULTS,
 *      not this asset's contract. They are recorded as such in
 *      BessWarrantyTerms.manufacturer_terms.provenance and in
 *      BessAsset.metadata.warranty_terms_source, and the warranty API reads
 *      that back so the UI can caption it. Never quote a defaulted limit to a
 *      customer or an OEM as a contractual number.
 *
 * The real path for genuine terms is the contract upload: put the warranty PDF
 * on the plant's contracts page and confirm the extracted terms. That confirm
 * route calls syncContractToBessWarrantyTerms() in src/lib/contracts/bess-sync.ts,
 * which maps the confirmed BESS_WARRANTY term values straight into these
 * columns and supersedes whatever this script defaulted.
 *
 * Idempotent: re-running with the same arguments converges. Existing warranty
 * terms are never overwritten unless --replace-terms is passed, so a contract
 * sync cannot be clobbered by a re-run.
 */

import dotenv from 'dotenv';

// Do NOT override an explicitly-passed DATABASE_URL. The house convention is
// `dotenv.config({ override: true })`, which silently replaces the DSN the
// caller exported with the one in .env: running this against prod would then
// quietly edit the local database instead, and report "no plant matched"
// because the slugs differ. An explicit env var always wins here.
dotenv.config({ override: !process.env.DATABASE_URL });

import { PrismaClient, AssetType, BessChemistry, Prisma } from '@prisma/client';

// ── Warranty baselines ─────────────────────────────────────────────────────

/**
 * Every column BessWarrantyTerms carries a number for, in the DB's own units
 * (fractions, not percents).
 */
export interface WarrantyBaseline {
  capacity_guarantee_pct: number;
  warranty_years: number;
  max_cycles: number;
  max_throughput_mwh: number | null;
  min_rte: number;
  max_avg_soc: number;
  min_soc: number;
  soc_hold_limit_hours: number;
  operating_temp_min_c: number;
  operating_temp_max_c: number;
  temp_violation_minutes: number;
  max_c_rate_continuous: number;
  max_c_rate_peak: number;
  peak_duration_minutes: number;
  cell_voltage_min_v: number;
  cell_voltage_max_v: number;
}

/**
 * An exact mirror of WarrantyTermsConfig in nuravolt/bess/config.py.
 *
 * This is not a style choice. BESSPipelineConfig builds WarrantyTermsConfig()
 * with no chemistry input, so the Python pipeline scores every asset against
 * these numbers: backfill_bess_intelligence.py divides cumulative cycles by
 * `warranty_terms.max_cycles` and elapsed years by `warranty_terms.warranty_years`
 * to write BessWarrantyStatus.cycle_usage_pct / time_usage_pct. The UI then
 * draws its cycle-budget and calendar-age bars from the terms row this script
 * writes. If the two disagree, the same battery shows two different budgets on
 * one screen. Keep them equal.
 */
export const WARRANTY_TERMS_BASELINE: WarrantyBaseline = {
  capacity_guarantee_pct: 0.7,
  warranty_years: 10,
  max_cycles: 5000,
  max_throughput_mwh: null,
  min_rte: 0.85,
  max_avg_soc: 0.95,
  min_soc: 0.1,
  soc_hold_limit_hours: 168,
  operating_temp_min_c: 15,
  operating_temp_max_c: 35,
  temp_violation_minutes: 30,
  max_c_rate_continuous: 1.0,
  max_c_rate_peak: 1.2,
  peak_duration_minutes: 15,
  cell_voltage_min_v: 2.8,
  cell_voltage_max_v: 3.65,
};

/**
 * Chemistry deltas, limited to the two things a cell chemistry actually fixes:
 * how many equivalent full cycles it survives to the capacity floor, and its
 * usable cell voltage window. LFP is empty on purpose so the default case stays
 * byte-identical to the Python baseline above.
 *
 * The C-rate, temperature and SoC limits are deliberately NOT varied here. They
 * are set by the pack and the enclosure, not the cell, so varying them would be
 * invention rather than derivation, and Python does not vary them either.
 *
 * Caveat worth knowing before you add a non-LFP asset: WarrantyTermsConfig is
 * chemistry-agnostic today, so a non-LFP cycle budget here is a budget the
 * Python scorer does not share. main() prints that mismatch when it applies.
 */
export const CHEMISTRY_WARRANTY_OVERRIDES: Record<
  keyof typeof BessChemistry,
  Partial<WarrantyBaseline>
> = {
  LFP: {},
  NMC: { max_cycles: 4000, cell_voltage_min_v: 3.0, cell_voltage_max_v: 4.2 },
  NCA: { max_cycles: 3000, cell_voltage_min_v: 3.0, cell_voltage_max_v: 4.2 },
  LTO: { max_cycles: 15000, cell_voltage_min_v: 1.5, cell_voltage_max_v: 2.8 },
};

export function warrantyBaselineFor(
  chemistry: keyof typeof BessChemistry
): WarrantyBaseline {
  return { ...WARRANTY_TERMS_BASELINE, ...CHEMISTRY_WARRANTY_OVERRIDES[chemistry] };
}

/** Where a BessWarrantyTerms row's numbers came from. */
export type WarrantyTermsSource =
  | 'contract'
  | 'operator_declared'
  | 'chemistry_default';

export interface ResolvedWarrantyTerms {
  values: WarrantyBaseline;
  /** Columns the caller supplied on the command line. */
  declaredFields: string[];
  /** Columns filled from the chemistry baseline. */
  defaultedFields: string[];
  source: WarrantyTermsSource;
}

/**
 * Merge caller-supplied limits over the chemistry baseline, recording which is
 * which. `supplied` keys are BessWarrantyTerms column names; an undefined or
 * null value counts as not supplied (null is how "no throughput cap" is
 * expressed, and that is also the baseline, so it is not a declaration).
 */
export function resolveWarrantyTerms(
  chemistry: keyof typeof BessChemistry,
  supplied: Partial<WarrantyBaseline>
): ResolvedWarrantyTerms {
  const baseline = warrantyBaselineFor(chemistry);
  const values = { ...baseline };
  const declaredFields: string[] = [];
  const defaultedFields: string[] = [];

  for (const key of Object.keys(baseline) as Array<keyof WarrantyBaseline>) {
    const given = supplied[key];
    if (given === undefined || given === null) {
      defaultedFields.push(key);
      continue;
    }
    (values as Record<string, unknown>)[key] = given;
    declaredFields.push(key);
  }

  return {
    values,
    declaredFields,
    defaultedFields,
    source: declaredFields.length ? 'operator_declared' : 'chemistry_default',
  };
}

/**
 * The provenance record stored in BessWarrantyTerms.manufacturer_terms. Kept
 * under its own `provenance` key so a genuine manufacturer-terms blob can live
 * alongside it later. The warranty API reads this back to caption the tracker.
 */
export function warrantyTermsProvenanceRecord(
  resolved: ResolvedWarrantyTerms,
  chemistry: keyof typeof BessChemistry,
  recordedAt: Date
): Record<string, unknown> {
  const note =
    resolved.source === 'chemistry_default'
      ? 'Chemistry defaults entered at setup. These are not this asset\'s warranty document. Upload the warranty and confirm its terms to replace them.'
      : 'Some limits were entered at setup and the rest are chemistry defaults. No warranty document has been read for this asset.';
  return {
    provenance: {
      source: resolved.source,
      is_contract_derived: false,
      chemistry,
      basis: `nuravolt/bess/config.py WarrantyTermsConfig, ${chemistry} baseline`,
      declared_fields: resolved.declaredFields,
      defaulted_fields: resolved.defaultedFields,
      recorded_by: 'scripts/add_bess_to_plant.ts',
      recorded_at: recordedAt.toISOString(),
      note,
    },
  };
}

// ── Commissioning date ─────────────────────────────────────────────────────

/**
 * Where a BessAsset.installation_date came from. Mirrors the constants in
 * nuravolt/pipeline/bess_intelligence.py, because both writers stamp the same
 * metadata key and each has to recognise the other's work.
 */
export type InstallationDateSource =
  | 'operator_declared'
  | 'contract'
  | 'oem_api'
  | 'measured'
  | 'existing_unattributed'
  | 'plant_commissioning'
  | 'modelled_window_start';

/** Sources that are a real claim about the hardware. Never re-derived. */
export const DECLARED_INSTALLATION_SOURCES: readonly string[] = [
  'operator_declared',
  'contract',
  'oem_api',
  'measured',
];

/**
 * Every source string this file understands. A date that is kept keeps its
 * label: relabelling an inference as somebody else's claim would drop the
 * "not a commissioning record" caption off a number that needs it.
 */
export const KNOWN_INSTALLATION_SOURCES: readonly string[] = [
  ...DECLARED_INSTALLATION_SOURCES,
  'existing_unattributed',
  'plant_commissioning',
  'modelled_window_start',
];

export interface InstallationDateInputs {
  /** --installation-date, an operator typing what they know. */
  declared?: Date | null;
  /** The value already on the row. */
  existing?: Date | null;
  /** metadata.installation_date_source from the row, if any. */
  existingSource?: string | null;
  /** Plant.commissioning_date. */
  plantCommissioning?: Date | null;
  /** Earliest day this asset already has persisted history for. */
  historyStart?: Date | null;
}

export interface ResolvedInstallationDate {
  date: Date | null;
  source: InstallationDateSource | null;
}

function sameDay(d: Date): Date {
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);
}

/**
 * The commissioning date to store, and where it came from.
 *
 * Precedence, best evidence first:
 *
 *   1. --installation-date. Somebody who can see the asset said so.
 *   2. A date already on the row whose recorded source is a real claim
 *      (contract, OEM API, a measured commissioning record, or an earlier
 *      --installation-date). Re-deriving over one of those would replace
 *      evidence with inference.
 *   3. A date already on the row with no recorded source, as long as it is
 *      possible: not after the first day the asset has history for. The seed
 *      scripts leave dates without a source and they are still somebody's
 *      claim. Only the impossible ones are replaced.
 *   4. Plant.commissioning_date. The battery is co-located, and this is the
 *      date the plant header already shows, so taking it puts one date on the
 *      screen instead of two.
 *   5. The start of the history the asset actually has. Not a commissioning
 *      record, but it is the earliest day the asset demonstrably existed,
 *      which is the weakest claim that is still true.
 *   6. Nothing. The column stays null and the console renders it absent.
 *
 * `new Date()` is deliberately not in that list. A battery installed today
 * cannot have a year of dispatch behind it, and the calendar-age bar reads off
 * this date.
 */
export function resolveInstallationDate(
  inputs: InstallationDateInputs
): ResolvedInstallationDate {
  const { declared, existing, existingSource, plantCommissioning, historyStart } = inputs;

  if (declared) return { date: sameDay(declared), source: 'operator_declared' };

  if (existing && existingSource && DECLARED_INSTALLATION_SOURCES.includes(existingSource)) {
    return { date: sameDay(existing), source: existingSource as InstallationDateSource };
  }
  if (existing && (!historyStart || sameDay(existing) <= sameDay(historyStart))) {
    return {
      date: sameDay(existing),
      source:
        existingSource && KNOWN_INSTALLATION_SOURCES.includes(existingSource)
          ? (existingSource as InstallationDateSource)
          : 'existing_unattributed',
    };
  }
  if (plantCommissioning) {
    return { date: sameDay(plantCommissioning), source: 'plant_commissioning' };
  }
  if (historyStart) {
    return { date: sameDay(historyStart), source: 'modelled_window_start' };
  }
  return { date: null, source: null };
}

/** How each source reads in the script's own output. */
export const INSTALLATION_SOURCE_LABEL: Record<InstallationDateSource, string> = {
  operator_declared: 'declared on the command line',
  contract: 'from a confirmed contract',
  oem_api: 'from the OEM API',
  measured: 'from measured commissioning telemetry',
  existing_unattributed: 'already on the row, source not recorded',
  plant_commissioning: 'the plant commissioning date',
  modelled_window_start: 'the start of the history this asset already has, not a commissioning record',
};

// ── Argument parsing ───────────────────────────────────────────────────────

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function num(flag: string): number | undefined {
  const v = arg(flag);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`${flag} must be a positive number, got "${v}"`);
    process.exit(1);
  }
  return n;
}

/** Any finite number, including zero and negatives (temperature floors). */
function anyNum(flag: string): number | undefined {
  const v = arg(flag);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`${flag} must be a number, got "${v}"`);
    process.exit(1);
  }
  return n;
}

function int(flag: string): number | undefined {
  const n = num(flag);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n)) {
    console.error(`${flag} must be a whole number, got "${n}"`);
    process.exit(1);
  }
  return n;
}

/**
 * A percentage flag, returned as the fraction the column stores. Values between
 * 0 and 1 are rejected rather than accepted: "--min-rte-pct 0.85" almost
 * certainly means 85 percent, and silently storing 0.85 percent would put a
 * fictional efficiency floor on a warranty screen.
 */
function pct(flag: string): number | undefined {
  const v = arg(flag);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    console.error(`${flag} must be a percentage between 0 and 100, got "${v}"`);
    process.exit(1);
  }
  if (n > 0 && n < 1) {
    console.error(
      `${flag} takes a percentage, not a fraction. For ${n * 100}% pass ${n * 100}, not ${n}.`
    );
    process.exit(1);
  }
  return Math.round(n * 100) / 10000;
}

function isoDate(flag: string): Date | undefined {
  const v = arg(flag);
  if (v === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    console.error(`${flag} must be an ISO date (YYYY-MM-DD), got "${v}"`);
    process.exit(1);
  }
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    console.error(`${flag} is not a real date: "${v}"`);
    process.exit(1);
  }
  return d;
}

function usage(): void {
  console.error('usage: --plant <slug|uuid> [--power-mw N] [--energy-mwh N] [--chemistry LFP]');
  console.error('       [--manufacturer X] [--model Y] [--country ES] [--asset-id bess-<slug>-001]');
  console.error('       [--installation-date YYYY-MM-DD]');
  console.error('');
  console.error('--installation-date is when the battery was installed, and it drives the');
  console.error('calendar-age axis of the warranty tracker. Omitted, it is taken from the');
  console.error('plant commissioning date, else from the start of the history the asset');
  console.error('already has, else left empty. It is never set to today.');
  console.error('');
  console.error('Warranty terms. Anything omitted is a chemistry default, recorded as such,');
  console.error('and must never be quoted as a contractual limit. The real terms arrive by');
  console.error('uploading the warranty PDF on the plant contracts page and confirming the');
  console.error('extracted terms, which syncs them into these same columns via');
  console.error('src/lib/contracts/bess-sync.ts.');
  console.error('       [--soh-eol-pct 70] [--warranty-years 10] [--max-cycles 5000]');
  console.error('       [--max-throughput-mwh N] [--min-rte-pct 85]');
  console.error('       [--max-avg-soc-pct 95] [--min-soc-pct 10] [--soc-hold-limit-hours 168]');
  console.error('       [--operating-temp-min-c 15] [--operating-temp-max-c 35]');
  console.error('       [--temp-violation-minutes 30]');
  console.error('       [--max-c-rate-continuous 1.0] [--max-c-rate-peak 1.2]');
  console.error('       [--peak-duration-minutes 15]');
  console.error('       [--cell-voltage-min-v 2.8] [--cell-voltage-max-v 3.65]');
  console.error('       [--warranty-from YYYY-MM-DD] [--replace-terms] [--no-warranty-terms]');
}

/** Command-line warranty limits, in the DB's units. */
function suppliedWarrantyTerms(): Partial<WarrantyBaseline> {
  return {
    capacity_guarantee_pct: pct('--soh-eol-pct'),
    warranty_years: int('--warranty-years'),
    max_cycles: int('--max-cycles'),
    max_throughput_mwh: num('--max-throughput-mwh'),
    min_rte: pct('--min-rte-pct'),
    max_avg_soc: pct('--max-avg-soc-pct'),
    min_soc: pct('--min-soc-pct'),
    soc_hold_limit_hours: int('--soc-hold-limit-hours'),
    operating_temp_min_c: anyNum('--operating-temp-min-c'),
    operating_temp_max_c: anyNum('--operating-temp-max-c'),
    temp_violation_minutes: int('--temp-violation-minutes'),
    max_c_rate_continuous: num('--max-c-rate-continuous'),
    max_c_rate_peak: num('--max-c-rate-peak'),
    peak_duration_minutes: int('--peak-duration-minutes'),
    cell_voltage_min_v: num('--cell-voltage-min-v'),
    cell_voltage_max_v: num('--cell-voltage-max-v'),
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

let client: PrismaClient | null = null;
/**
 * Lazy so that importing this module for its pure helpers (the unit tests do)
 * neither needs a DATABASE_URL nor opens a connection.
 */
function db(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}

async function main() {
  const prisma = db();
  const plantRef = arg('--plant');
  if (!plantRef) {
    usage();
    process.exit(1);
  }

  const plant = await prisma.plant.findFirst({
    where: { OR: [{ slug: plantRef }, { id: plantRef }] },
    include: { organization: true },
  });
  if (!plant) {
    console.error(`No plant matched "${plantRef}".`);
    process.exit(1);
  }

  const powerMw = num('--power-mw') ?? 5;
  const energyMwh = num('--energy-mwh') ?? 10;
  const chemistryRaw = (arg('--chemistry') ?? 'LFP').toUpperCase();
  if (!(chemistryRaw in BessChemistry)) {
    console.error(`--chemistry must be one of ${Object.keys(BessChemistry).join(', ')}`);
    process.exit(1);
  }
  const chemistryKey = chemistryRaw as keyof typeof BessChemistry;
  const chemistry = BessChemistry[chemistryKey];
  const externalAssetId = arg('--asset-id') ?? `bess-${plant.slug}-001`;
  const country = arg('--country');
  const skipTerms = flag('--no-warranty-terms');
  const replaceTerms = flag('--replace-terms');
  const warrantyFrom = isoDate('--warranty-from');
  const declaredInstall = isoDate('--installation-date');
  if (declaredInstall && declaredInstall.getTime() > Date.now()) {
    console.error('--installation-date is in the future. A battery cannot have been installed later than today.');
    process.exit(1);
  }
  // Parsed before any write: a bad --min-rte-pct must not leave the plant half
  // converted.
  const terms = resolveWarrantyTerms(chemistryKey, suppliedWarrantyTerms());

  if (plant.asset_type === AssetType.WIND || plant.asset_type === AssetType.HYDROGEN) {
    console.error(
      `Plant "${plant.slug}" is ${plant.asset_type}. This script only converts PV to HYBRID, ` +
        'because HYBRID is defined as PV plus storage across the pipeline.'
    );
    process.exit(1);
  }

  const nextAssetType =
    plant.asset_type === AssetType.PV ? AssetType.HYBRID : plant.asset_type;

  console.log(`Plant "${plant.name}" (${plant.slug})`);
  console.log(`  org:        ${plant.organization?.name ?? 'unowned'}`);
  console.log(`  asset_type: ${plant.asset_type}${nextAssetType !== plant.asset_type ? ` -> ${nextAssetType}` : ' (unchanged)'}`);
  console.log(`  battery:    ${powerMw} MW / ${energyMwh} MWh ${chemistryRaw}`);

  if (!plant.organization_id) {
    console.warn(
      'Warning: this plant has no organization, so it will not appear in a signed-in dashboard ' +
        '(dashboard reads are org-scoped).'
    );
  }
  if (!plant.country && !country) {
    console.warn(
      'Warning: this plant has no country. The dispatch twin falls back to the ES zone rather ' +
        'than raising, so prices would be Iberian by default. Pass --country to set it explicitly.'
    );
  }

  // Sum the plant's declared storage so the pricing meter sees the whole site.
  const siblings = await prisma.bessAsset.findMany({
    where: { plant_id: plant.id, external_asset_id: { not: externalAssetId } },
    select: { nominal_capacity_kwh: true },
  });
  const siblingMwh = siblings.reduce(
    (sum, a) => sum + Number(a.nominal_capacity_kwh ?? 0) / 1000,
    0
  );
  const totalMwh = Math.round((siblingMwh + energyMwh) * 1000) / 1000;

  await prisma.plant.update({
    where: { id: plant.id },
    data: {
      asset_type: nextAssetType,
      energy_capacity_mwh: totalMwh,
      ...(country && !plant.country ? { country: country.toUpperCase() } : {}),
    },
  });

  const existing = await prisma.bessAsset.findFirst({
    where: { plant_id: plant.id, external_asset_id: externalAssetId },
  });

  // Merge, do not clobber: the Python pipeline writes its own keys (zone,
  // currency, price_source, resolution_minutes) into this same column, and a
  // re-run of this script must not erase them.
  const priorMetadata =
    existing?.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
      ? (existing.metadata as Record<string, unknown>)
      : {};

  // The earliest day this asset already has persisted history for. Both tables
  // are consulted because the two writers fill them on slightly different
  // windows, and the earlier of the two is the one that can contradict an
  // installation date. On a new asset both are empty and this stays null.
  const historyStart = existing ? await earliestHistoryDay(existing.id) : null;
  const install = resolveInstallationDate({
    declared: declaredInstall,
    existing: existing?.installation_date ?? null,
    existingSource:
      typeof priorMetadata.installation_date_source === 'string'
        ? priorMetadata.installation_date_source
        : null,
    plantCommissioning: plant.commissioning_date,
    historyStart,
  });
  if (
    install.source === 'operator_declared' &&
    historyStart &&
    install.date! > historyStart
  ) {
    console.warn(
      `\nWarning: this asset already has history from ${historyStart.toISOString().slice(0, 10)},\n` +
        `which is before the installation date you passed. Rebuild the twin\n` +
        `(scripts/backfill_bess_intelligence.py) so the modelled window starts at installation;\n` +
        'until you do, the console will show dispatch for days the battery was not yet on site.'
    );
  }

  const data = {
    plant_id: plant.id,
    external_asset_id: externalAssetId,
    name: `${plant.name} storage`,
    chemistry,
    nominal_capacity_kwh: energyMwh * 1000,
    nominal_power_kw: powerMw * 1000,
    manufacturer: arg('--manufacturer') ?? null,
    model: arg('--model') ?? null,
    // Resolved, never stamped from the clock: see resolveInstallationDate.
    // Deterministic in its inputs, so re-running converges instead of walking
    // the commissioning date forward a day at a time.
    installation_date: install.date,
    enabled: true,
    // Declared, not commissioned, and no BMS behind it. Downstream provenance
    // labelling reads this; bess_assets.py uses {"synthesized": true} for the
    // rows it invents, and this is the operator-declared equivalent.
    metadata: {
      ...priorMetadata,
      declared_nameplate: true,
      measured_telemetry: false,
      ...(install.source ? { installation_date_source: install.source } : {}),
      note: 'Nameplate declared during setup. No BMS connected, so every battery number for this asset is modelled.',
    } as Prisma.InputJsonValue,
  };

  const asset = existing
    ? await prisma.bessAsset.update({ where: { id: existing.id }, data })
    : await prisma.bessAsset.create({ data });

  console.log(`\n${existing ? 'Updated' : 'Created'} BessAsset ${asset.external_asset_id}`);
  if (install.date && install.source) {
    console.log(
      `  installed:  ${install.date.toISOString().slice(0, 10)} (${INSTALLATION_SOURCE_LABEL[install.source]})`
    );
  } else {
    console.log(
      '  installed:  not known, left empty. The console renders it absent and the warranty\n' +
        '              calendar-age axis has nothing to measure from. Pass --installation-date\n' +
        '              once somebody can say, or set the plant commissioning date.'
    );
  }

  if (!skipTerms) {
    // The warranty clock starts at installation. With no installation date the
    // only date this script can honestly stamp is the day the limits were
    // entered, which is a fact about the row rather than about the battery, so
    // it says so rather than passing it off as a commissioning date.
    const anchor = warrantyFrom ?? asset.installation_date ?? null;
    if (!anchor) {
      console.warn(
        '\nWarranty terms will be dated from today, because this asset has no installation\n' +
          'date. That is when the limits were entered, not when the warranty started. Pass\n' +
          '--warranty-from or --installation-date to date it properly.'
      );
    }
    await writeWarrantyTerms({
      assetId: asset.id,
      chemistry: chemistryKey,
      terms,
      effectiveFrom: anchor ?? new Date(),
      anchored: anchor != null,
      replaceTerms,
    });
  } else {
    console.log(
      '\nWarranty terms skipped (--no-warranty-terms). The warranty tracker, the violation\n' +
        'detector and the dossier all read BessWarrantyTerms, so they will render as\n' +
        'unavailable for this asset until a row exists.'
    );
  }

  console.log(`\nPlant storage total: ${totalMwh} MWh`);
  console.log(`Equivalent MW for billing: ${Math.max(Number(plant.capacity_mw ?? 0), totalMwh / 4)}`);
  console.log(`\nVisit /dashboard/plant/${plant.slug}/bess`);
  console.log(
    'The console will be sparse until the nightly builds the dispatch twin. To fill it now:\n' +
      `  DATABASE_URL=<dsn> python scripts/backfill_bess_intelligence.py --plant ${plant.slug}`
  );
}

const TERM_LINES: Array<[keyof WarrantyBaseline, (v: number | null) => string]> = [
  ['capacity_guarantee_pct', (v) => `capacity guarantee   ${((v ?? 0) * 100).toFixed(0)}% at end of warranty`],
  ['warranty_years', (v) => `warranty length      ${v} yr`],
  ['max_cycles', (v) => `cycle budget         ${v} equivalent full cycles`],
  ['max_throughput_mwh', (v) => `throughput budget    ${v == null ? 'none' : `${v} MWh`}`],
  ['min_rte', (v) => `round trip floor     ${((v ?? 0) * 100).toFixed(0)}%`],
  ['max_avg_soc', (v) => `high SoC limit       ${((v ?? 0) * 100).toFixed(0)}%`],
  ['min_soc', (v) => `low SoC limit        ${((v ?? 0) * 100).toFixed(0)}%`],
  ['soc_hold_limit_hours', (v) => `SoC dwell limit      ${v} h`],
  ['operating_temp_min_c', (v) => `temperature floor    ${v} C`],
  ['operating_temp_max_c', (v) => `temperature ceiling  ${v} C`],
  ['temp_violation_minutes', (v) => `temp dwell trigger   ${v} min`],
  ['max_c_rate_continuous', (v) => `continuous C rate    ${v}C`],
  ['max_c_rate_peak', (v) => `peak C rate          ${v}C`],
  ['peak_duration_minutes', (v) => `peak duration        ${v} min`],
  ['cell_voltage_min_v', (v) => `cell voltage floor   ${v} V`],
  ['cell_voltage_max_v', (v) => `cell voltage ceiling ${v} V`],
];

/**
 * The earliest day this asset already has persisted operating history for.
 * Null when it has none. Used to detect an installation date that is later
 * than the asset's own history, which is the impossible case.
 */
async function earliestHistoryDay(assetId: string): Promise<Date | null> {
  const prisma = db();
  const [dispatch, cycles] = await Promise.all([
    prisma.bessDispatchSchedule.aggregate({
      where: { asset_id: assetId },
      _min: { schedule_date: true },
    }),
    prisma.bessCycleRecord.aggregate({
      where: { asset_id: assetId },
      _min: { cycle_date: true },
    }),
  ]);
  const days = [dispatch._min.schedule_date, cycles._min.cycle_date].filter(
    (d): d is Date => d instanceof Date
  );
  if (!days.length) return null;
  return days.reduce((a, b) => (a < b ? a : b));
}

async function writeWarrantyTerms(opts: {
  assetId: string;
  chemistry: keyof typeof BessChemistry;
  terms: ResolvedWarrantyTerms;
  effectiveFrom: Date;
  /** False when effectiveFrom is just "today", with no date to anchor to. */
  anchored: boolean;
  replaceTerms: boolean;
}) {
  const { assetId, chemistry, terms, effectiveFrom, anchored, replaceTerms } = opts;
  const prisma = db();
  const existingTerms = await prisma.bessWarrantyTerms.findUnique({
    where: { asset_id: assetId },
  });

  if (existingTerms && !replaceTerms) {
    console.log(
      `\nWarranty terms already on file (effective ${existingTerms.effective_from
        .toISOString()
        .slice(0, 10)}), left untouched.\n` +
        'Pass --replace-terms to overwrite. Check first whether a confirmed warranty contract\n' +
        'wrote them: src/lib/contracts/bess-sync.ts is one way, and overwriting contract\n' +
        'numbers with chemistry defaults would be a downgrade, not a fix.'
    );
    return;
  }

  const record = warrantyTermsProvenanceRecord(terms, chemistry, new Date());
  const row = {
    ...terms.values,
    manufacturer_terms: record as Prisma.InputJsonValue,
    effective_from: effectiveFrom,
  };

  if (existingTerms) {
    await prisma.bessWarrantyTerms.update({ where: { asset_id: assetId }, data: row });
  } else {
    await prisma.bessWarrantyTerms.create({ data: { asset_id: assetId, ...row } });
  }

  // Mirror the distinction onto the asset too, so anything reading the asset
  // row alone still knows these limits are not a customer's contract.
  const asset = await prisma.bessAsset.findUnique({ where: { id: assetId } });
  const assetMeta =
    asset?.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata)
      ? (asset.metadata as Record<string, unknown>)
      : {};
  await prisma.bessAsset.update({
    where: { id: assetId },
    data: {
      metadata: {
        ...assetMeta,
        warranty_terms_source: terms.source,
        warranty_terms_from_contract: false,
      } as Prisma.InputJsonValue,
    },
  });

  const declared = new Set(terms.declaredFields);
  console.log(`\n${existingTerms ? 'Replaced' : 'Created'} BessWarrantyTerms (${chemistry})`);
  for (const [key, render] of TERM_LINES) {
    const value = terms.values[key];
    const tag = declared.has(key) ? '[supplied]' : '[chemistry default]';
    console.log(`  ${render(value as number | null).padEnd(46)} ${tag}`);
  }
  console.log(
    `  effective from       ${effectiveFrom.toISOString().slice(0, 10)}` +
      (anchored ? '' : '   [the day these limits were entered, not a commissioning date]')
  );
  console.log('');
  console.log(
    'Lines marked [chemistry default] came from nuravolt/bess/config.py WarrantyTermsConfig,\n' +
      'not from this asset\'s warranty document. Do not quote them to a customer or an OEM as\n' +
      'contractual limits. The API and the UI label them as defaults.\n' +
      '\n' +
      'To load the real terms: upload the warranty PDF on the plant contracts page and confirm\n' +
      'the extracted terms. The confirm route runs syncContractToBessWarrantyTerms()\n' +
      '(src/lib/contracts/bess-sync.ts), which writes the contract numbers into these columns.'
  );

  if (chemistry !== 'LFP') {
    console.warn(
      `\nWarning: ${chemistry} takes a different cycle budget and cell voltage window than the\n` +
        'shared baseline, but nuravolt/bess/config.py WarrantyTermsConfig is chemistry-agnostic,\n' +
        'so backfill_bess_intelligence.py will still score cycle usage against 5000 equivalent\n' +
        `full cycles rather than ${terms.values.max_cycles}. Expect the cycle-usage percentage in\n` +
        'BessWarrantyStatus to disagree with the cycle-budget bar until config.py grows a\n' +
        'per-chemistry table.'
    );
  }
}

// Only run when invoked as a script. The unit tests import this module for the
// warranty baseline helpers, and an import must not parse another process's
// argv or touch the database.
if ((process.argv[1] ?? '').endsWith('add_bess_to_plant.ts')) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => db().$disconnect());
}
