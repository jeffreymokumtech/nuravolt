import type { OnboardingConnectionType } from '@/types/onboarding';

/**
 * Single source of truth for which connector backends actually exist. Must
 * mirror the type whitelist in POST /api/connections — a vendor may only be
 * 'available' or 'beta' here if the API accepts its type.
 *
 *  - available: real client, test + discover + (cloud) polling work.
 *  - beta: accepted by the API but test/discover still stubbed; expect manual
 *    help from us during setup.
 *  - coming_soon: UI-only. Card renders disabled with a notify-me capture.
 */
export type VendorAvailability = 'available' | 'beta' | 'coming_soon';

export const VENDOR_AVAILABILITY: Record<OnboardingConnectionType, VendorAvailability> = {
  sample_api: 'available',
  influxdb: 'available',
  huawei_api: 'available',
  solaredge_api: 'available',
  csv_upload: 'available',
  modbus_tcp: 'beta',
  sql_scada: 'beta',
  sunspec: 'coming_soon',
  sungrow_api: 'coming_soon',
  sma_api: 'coming_soon',
  fronius_api: 'coming_soon',
  goodwe_api: 'coming_soon',
};

export function vendorAvailability(type: OnboardingConnectionType): VendorAvailability {
  return VENDOR_AVAILABILITY[type] ?? 'coming_soon';
}

export const AVAILABILITY_BADGE: Record<Exclude<VendorAvailability, 'available'>, string> = {
  beta: 'Beta',
  coming_soon: 'Coming soon',
};
