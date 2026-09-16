import prisma from '@/libs/prisma';
import { Prisma, AssetType, BessChemistry } from '@prisma/client';
import { getCompliancePack } from '@/config/compliance';
import { getOrCreateOrganization } from '@/lib/organizations';
import {
  DURATION_REFERENCE_HOURS,
  equivalentMw,
  getOrgBilling,
  getOrgCapacityUsage,
} from '@/lib/billing/plan';
import { triggerPlantOnboarding } from '@/lib/analytics/trigger-onboarding';

/**
 * Shared plant-creation service — the single implementation behind
 * POST /api/plants AND the DiscoveredPlant promotion path
 * (src/lib/onboarding/promote.ts). Moved verbatim from the plants route so
 * plan limits, slug generation, compliance resolution and the creation
 * transaction cannot drift between the two entry points.
 */

// Demo org ID for demo mode (null until real orgs exist; will come from auth in production)
const DEMO_ORG_ID: string | null = null;

export interface InverterInput {
  external_id: string;
  name?: string;
  model?: string;
  nominal_power_kw?: number;
  mppt_count?: number;
  strings_per_mppt?: number;
}

export interface InverterGroupInput {
  name: string;
  tilt: number;
  azimuth: number;
  inverter_model?: string;
  inverter_nominal_power_kw?: number;
  mppt_count?: number;
  strings_per_mppt?: number;
  gamma_pdc?: number;
  inverters: InverterInput[];
}

export interface DataSourceInput {
  name: string;
  source_type: string;
  purpose: string;
  connection_id?: string;
  provides_metrics?: string[];
  polling_interval?: number;
  is_primary?: boolean;
}

/**
 * Battery nameplate declared during onboarding. Field semantics mirror
 * nuravolt/pipeline/bess_assets.py::ensure_bess_asset (same table, same
 * external_asset_id / name conventions) so a row written here and a row written
 * by the pipeline are interchangeable. The difference is provenance: everything
 * here is operator-declared, so nothing is assumed from AC capacity.
 */
export interface BessAssetInput {
  /** Id in the operator's own system. Defaults to BESS-<plant slug>. */
  external_asset_id?: string;
  name?: string;
  chemistry?: BessChemistry;
  /** Nameplate energy capacity. Falls back to the plant-level energy_capacity_mwh. */
  energy_capacity_mwh?: number;
  /** Continuous power rating. Falls back to the plant's rated MW. */
  power_mw?: number;
  rack_count?: number;
  module_count?: number;
  manufacturer?: string;
  model?: string;
  serial_number?: string;
  /** ISO date. */
  installation_date?: string;
  max_continuous_c_rate?: number;
  /** GB market identifiers, stored on BessAsset.metadata as { gb: { ... } }. */
  gb?: { bmu_id?: string; cmu_id?: string };
}

export interface CreatePlantRequest {
  name: string;
  asset_type?: AssetType;
  location_name?: string;
  latitude: number;
  longitude: number;
  altitude?: number;
  timezone?: string;
  capacity_mw: number;
  installed_mw?: number;
  /** Storage energy capacity. NULL/absent for PV and wind. */
  energy_capacity_mwh?: number | null;
  /** Battery nameplate. Creates the plant's BessAsset when asset_type is BESS or HYBRID. */
  storage?: BessAssetInput;
  commissioning_date?: string;
  has_weather_station?: boolean;
  irradiance_sensor_type?: string;
  sensor_mounted_at_tilt?: boolean;
  has_dustiq_sensor?: boolean;
  currency?: string;
  country?: string;              // ISO 3166-1 alpha-2
  metadata?: Record<string, any>;
  inverter_groups?: InverterGroupInput[];
  data_sources?: DataSourceInput[];
}

export type CreatedPlant = Prisma.PlantGetPayload<{
  include: {
    inverter_groups: { include: { inverters: true } };
    data_sources: true;
    bess_assets: true;
  };
}>;

export type CreatePlantOutcome =
  | { ok: true; plant: CreatedPlant }
  | { ok: false; status: number; body: { error: string; detail?: string; upgrade_url?: string } };

export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function generateGroupSlug(name: string): string {
  return generateSlug(name);
}

const VALID_CHEMISTRIES: BessChemistry[] = ['LFP', 'NMC', 'NCA', 'LTO'];

/** Declared storage energy (MWh), or null when none was declared. */
function resolveStorageMwh(body: CreatePlantRequest): number | null {
  const raw = body.energy_capacity_mwh ?? body.storage?.energy_capacity_mwh ?? null;
  if (raw == null) return null;
  const mwh = Number(raw);
  return Number.isFinite(mwh) && mwh > 0 ? mwh : null;
}

const trimmed = (v: string | undefined): string | undefined => {
  const s = v?.trim();
  return s ? s : undefined;
};

const positive = (v: number | undefined): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Int columns (rack/module counts) reject floats at the driver, so round here. */
const positiveInt = (v: number | undefined): number | undefined => {
  const n = positive(v);
  return n == null ? undefined : Math.round(n);
};

/**
 * Create a Plant (+ groups/inverters/data sources) for the given Better Auth
 * org id, enforcing plan limits. `authOrgId` null/undefined or 'demo_…' keeps
 * the historic behavior: plant is created unaffiliated (dev demo convenience),
 * no limits applied.
 */
export async function createPlantForOrg(
  authOrgId: string | null | undefined,
  body: CreatePlantRequest,
): Promise<CreatePlantOutcome> {
  try {
    // Declared storage energy, if any. Accepted at plant level or inside the
    // storage block; the plant-level column is what the pricing meter reads.
    const declaredMwh = resolveStorageMwh(body);
    const addedEquivalentMw = equivalentMw(body.capacity_mw, declaredMwh);

    // Resolve the caller's org (Better Auth session; demo ids in dev).
    // Plan limits (plant count + capacity under management) are enforced per org.
    let organizationId: string | undefined = DEMO_ORG_ID || undefined;
    if (authOrgId && !authOrgId.startsWith('demo_')) {
      const organization = await getOrCreateOrganization(authOrgId);
      organizationId = organization.id;

      const { plan, limits } = await getOrgBilling(authOrgId);

      // No plan at all: friendlier copy than the generic count/MW 402s.
      if (plan === 'free') {
        return {
          ok: false,
          status: 402,
          body: {
            error: 'plan_required',
            detail:
              'Pick a plan to onboard plants — Residential starts at €9/mo with a 14-day free trial.',
            upgrade_url: '/pricing',
          },
        };
      }

      if (Number.isFinite(limits.plants)) {
        const plantCount = await prisma.plant.count({
          where: { organization_id: organization.id },
        });
        if (plantCount >= limits.plants) {
          return {
            ok: false,
            status: 402,
            body: {
              error: 'plant_limit_reached',
              detail: `The ${plan} plan includes ${limits.plants} plant${limits.plants === 1 ? '' : 's'}. Upgrade to add more.`,
              upgrade_url: '/pricing',
            },
          };
        }
      }

      if (Number.isFinite(limits.mw)) {
        const usage = await getOrgCapacityUsage(organization.id);
        if (usage.equivalentMw + addedEquivalentMw > limits.mw) {
          const round = (n: number) => Math.round(n * 1000) / 1000;
          return {
            ok: false,
            status: 402,
            body: {
              error: 'mw_limit_reached',
              detail:
                `Your ${plan} plan covers ${limits.mw} equivalent MW under management. ` +
                `Equivalent MW is the larger of a plant's rated MW and its storage MWh divided by ${DURATION_REFERENCE_HOURS}. ` +
                `You have ${round(usage.equivalentMw)} and this plant adds ${round(addedEquivalentMw)}. ` +
                'Upgrade your capacity band to add it.',
              upgrade_url: '/pricing',
            },
          };
        }
      }
    }

    // Validate asset_type if provided
    const validAssetTypes: AssetType[] = ['PV', 'BESS', 'WIND', 'HYBRID'];
    if (body.asset_type && !validAssetTypes.includes(body.asset_type)) {
      return {
        ok: false,
        status: 400,
        body: { error: `Invalid asset_type. Must be one of: ${validAssetTypes.join(', ')}` },
      };
    }

    // Generate slug and ensure uniqueness
    let slug = generateSlug(body.name);
    const existingSlug = await prisma.plant.findUnique({ where: { slug } });
    if (existingSlug) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }

    // Resolve country + compliance pack — pack drives currency default if not set.
    const countryIso = body.country?.toUpperCase() || null;
    const pack = getCompliancePack(countryIso);
    const resolvedCurrency = body.currency || pack?.default_currency || 'EUR';
    // Only accept a real IANA zone — an invalid string here would poison every
    // downstream tz consumer (twin pipeline, plant-local chart axes).
    const isValidTz = (tz: string | undefined): tz is string => {
      if (!tz) return false;
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    };
    const resolvedTimezone = isValidTz(body.timezone)
      ? body.timezone
      : pack?.default_timezone || 'UTC';

    // Create plant with all related entities in a transaction
    const plant = await prisma.$transaction(async (tx) => {
      // 1. Create the plant
      const newPlant = await tx.plant.create({
        data: {
          organization_id: organizationId,
          slug,
          name: body.name,
          asset_type: body.asset_type || 'PV',
          location_name: body.location_name,
          latitude: body.latitude,
          longitude: body.longitude,
          altitude: body.altitude,
          timezone: resolvedTimezone,
          capacity_mw: body.capacity_mw,
          installed_mw: body.installed_mw,
          energy_capacity_mwh: declaredMwh ?? undefined,
          status: 'ONBOARDING',
          commissioning_date: body.commissioning_date
            ? new Date(body.commissioning_date)
            : undefined,
          has_weather_station: body.has_weather_station ?? false,
          irradiance_sensor_type: body.irradiance_sensor_type,
          sensor_mounted_at_tilt: body.sensor_mounted_at_tilt ?? false,
          has_dustiq_sensor: body.has_dustiq_sensor ?? false,
          currency: resolvedCurrency,
          country: countryIso,
          compliance_pack_version: pack?.version ?? null,
          metadata: body.metadata || undefined,
        },
      });

      // 1b. Create the battery nameplate for storage assets. Same transaction as
      // the plant: a BESS plant without a BessAsset has nowhere to write
      // dispatch, cycling or warranty rows, so the two must not drift apart.
      //
      // Guard on declared energy on purpose. nuravolt/pipeline/bess_assets.py
      // assumes a 2h duration when it has to invent a nameplate, and flags the
      // row `synthesized`. Here there is a human in the loop, so an undeclared
      // MWh means no row rather than an invented one.
      const assetType = body.asset_type || 'PV';
      if ((assetType === 'BESS' || assetType === 'HYBRID') && declaredMwh) {
        const s = body.storage ?? {};
        const chemistry =
          s.chemistry && VALID_CHEMISTRIES.includes(s.chemistry) ? s.chemistry : null;
        const installDate = s.installation_date ? new Date(s.installation_date) : null;

        const metadata: Record<string, any> = {};
        const bmuId = trimmed(s.gb?.bmu_id);
        const cmuId = trimmed(s.gb?.cmu_id);
        if (bmuId || cmuId) {
          metadata.gb = {
            ...(bmuId ? { bmu_id: bmuId } : {}),
            ...(cmuId ? { cmu_id: cmuId } : {}),
          };
        }
        if (positive(s.max_continuous_c_rate)) {
          metadata.max_continuous_c_rate = positive(s.max_continuous_c_rate);
        }
        // The chemistry column cannot be null, so an undeclared chemistry is
        // recorded as such instead of passing off the LFP fallback as a fact.
        if (!chemistry) metadata.chemistry_declared = false;

        await tx.bessAsset.create({
          data: {
            plant_id: newPlant.id,
            external_asset_id: trimmed(s.external_asset_id) || `BESS-${slug}`,
            name: trimmed(s.name) || `${body.name} storage`,
            chemistry: chemistry ?? 'LFP',
            nominal_capacity_kwh: declaredMwh * 1000,
            nominal_power_kw: (positive(s.power_mw) ?? body.capacity_mw) * 1000,
            module_count: positiveInt(s.module_count) ?? null,
            rack_count: positiveInt(s.rack_count) ?? null,
            installation_date:
              installDate && !Number.isNaN(installDate.getTime()) ? installDate : null,
            manufacturer: trimmed(s.manufacturer) ?? null,
            model: trimmed(s.model) ?? null,
            serial_number: trimmed(s.serial_number) ?? null,
            metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
            enabled: true,
          },
        });
      }

      // 2. Create inverter groups and their inverters
      if (body.inverter_groups && body.inverter_groups.length > 0) {
        for (const group of body.inverter_groups) {
          const groupSlug = generateGroupSlug(group.name);

          const newGroup = await tx.inverterGroup.create({
            data: {
              plant_id: newPlant.id,
              name: group.name,
              slug: groupSlug,
              tilt: group.tilt,
              azimuth: group.azimuth,
              inverter_model: group.inverter_model,
              inverter_nominal_power_kw: group.inverter_nominal_power_kw,
              mppt_count: group.mppt_count,
              strings_per_mppt: group.strings_per_mppt,
              gamma_pdc: group.gamma_pdc,
            },
          });

          // Create inverters for this group
          if (group.inverters && group.inverters.length > 0) {
            await tx.inverter.createMany({
              data: group.inverters.map((inv) => ({
                group_id: newGroup.id,
                external_id: inv.external_id,
                name: inv.name,
                model: inv.model || group.inverter_model,
                nominal_power_kw: inv.nominal_power_kw || group.inverter_nominal_power_kw,
                mppt_count: inv.mppt_count || group.mppt_count,
                strings_per_mppt: inv.strings_per_mppt || group.strings_per_mppt,
                enabled: true,
              })),
            });
          }
        }
      }

      // 3. Create data sources
      if (body.data_sources && body.data_sources.length > 0) {
        await tx.plantDataSource.createMany({
          data: body.data_sources.map((ds) => ({
            plant_id: newPlant.id,
            connection_id: ds.connection_id || null,
            name: ds.name,
            source_type: ds.source_type as any,
            purpose: ds.purpose as any,
            provides_metrics: ds.provides_metrics || [],
            polling_interval: ds.polling_interval || 900,
            is_primary: ds.is_primary ?? false,
            enabled: true,
          })),
        });
      }

      // Return the full plant with relations
      return tx.plant.findUnique({
        where: { id: newPlant.id },
        include: {
          inverter_groups: {
            include: {
              inverters: true,
            },
          },
          data_sources: true,
          bess_assets: true,
        },
      });
    });

    if (!plant) {
      return { ok: false, status: 500, body: { error: 'Failed to create plant' } };
    }

    // Kick off cold-start analytics (fire-and-forget; nightly sweep is the
    // safety net if the dispatch fails).
    triggerPlantOnboarding(plant.id).catch(() => {});

    return { ok: true, plant };
  } catch (error) {
    console.error('Error creating plant:', error);

    // Handle unique constraint violations
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return {
        ok: false,
        status: 409,
        body: { error: 'A plant with this slug already exists. Please choose a different name.' },
      };
    }

    return { ok: false, status: 500, body: { error: 'Failed to create plant' } };
  }
}
