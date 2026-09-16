import { NextRequest, NextResponse } from 'next/server';
import { requireOrg, hasOrgManageRole, forbidden } from '@/lib/api/tenant';
import { promoteDiscoveredPlant, type PromoteOverrides } from '@/lib/onboarding/promote';

/**
 * POST /api/connections/[connectionId]/promote
 *
 * Zero-touch onboarding: turn a DiscoveredPlant (captured by /discover) into
 * a real Plant + InverterGroup + Inverters + PlantDataSource, then kick the
 * analytics pipeline. Body: { external_plant_id, overrides? }.
 *
 * 201 on create, 200 when already promoted (idempotent), 402 plan limits,
 * 422 discovery_incomplete { missing[] } when the vendor omitted required
 * fields (client re-submits with overrides).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { connectionId: string } },
) {
  const orgResult = await requireOrg();
  if (!orgResult.ok) return orgResult.response;
  const { ctx } = orgResult;
  if (!hasOrgManageRole(ctx)) return forbidden('org_manage_role_required');

  let body: { external_plant_id?: string; overrides?: PromoteOverrides };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!body.external_plant_id) {
    return NextResponse.json({ error: 'external_plant_id is required' }, { status: 400 });
  }

  try {
    const outcome = await promoteDiscoveredPlant(
      ctx,
      params.connectionId,
      body.external_plant_id,
      body.overrides ?? {},
    );

    if (!outcome.ok) {
      return NextResponse.json(outcome.body, { status: outcome.status });
    }

    return NextResponse.json(
      { data: outcome.plant, created: outcome.created },
      { status: outcome.created ? 201 : 200 },
    );
  } catch (error) {
    console.error('[promote] failed:', error);
    return NextResponse.json({ error: 'Failed to promote discovered plant' }, { status: 500 });
  }
}
