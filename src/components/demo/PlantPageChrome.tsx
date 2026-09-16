'use client';

/**
 * PlantPageChrome, shared chrome for plant detail pages.
 *
 * Used by both `/demo/plant/[plantId]/layout.tsx` and
 * `/showcase/plant/[plantId]/layout.tsx`. The `routePrefix` prop decides where
 * portfolio/plant links point.
 *
 * Responsibilities:
 *   - Sticky top header: logo (→ portfolio), mode pill, language switcher,
 *     anonymization toggle, plant selector
 *   - Left sidebar with per-plant section switcher (hash-based nav)
 *   - Plant info card with capacity / turbines / inverter groups
 *   - Mobile hamburger menu
 *
 * The sidebar collapses on inverter/mppt/string drill-down pages, detected
 * via `pathname.includes('/inverter/')`.
 */

import Link from 'next/link';
import { usePathname, useParams, useRouter } from 'next/navigation';
import { ReactNode, useState, useCallback, useMemo } from 'react';
import NuraVoltLogo from '@/components/NuraVoltLogo';
import {
  Menu,
  X,
  LayoutGrid,
  LayoutDashboard,
  AlertTriangle,
  Droplets,
  Battery,
  Shield,
  Ticket,
  Database,
  Settings,
  Wind,
  DollarSign,
  CalendarClock,
  Gauge,
  FileCheck,
  Scale,
} from 'lucide-react';
import PlantSelector from '@/components/PlantSelector';
import AnonymizationToggle from '@/components/demo/AnonymizationToggle';
import { useAnonymization } from '@/contexts/AnonymizationContext';
import { useDemoPlants, assetTypeChip } from '@/contexts/DemoPlantContext';
import { usePlantGroups } from '@/hooks/usePlantGroups';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import { useLanguage } from '@/contexts/LanguageContext';

type AssetType = 'SOLAR' | 'WIND' | 'BESS';

// Asset-accent chip rendered next to the mode pill on the plant header.
// Calm by design, a small coloured dot + uppercase label that lets you
// recognise the plant's type at a glance without colouring the whole chrome.
const ASSET_CHIP: Record<
  AssetType,
  { dot: string; chip: string; label: string }
> = {
  SOLAR: {
    dot: 'bg-asset-solar',
    chip: 'bg-blue-50 text-asset-solar border-blue-200',
    label: 'PV',
  },
  WIND: {
    dot: 'bg-asset-wind',
    chip: 'bg-cyan-50 text-asset-wind border-cyan-200',
    label: 'Wind',
  },
  BESS: {
    dot: 'bg-asset-bess',
    chip: 'bg-violet-50 text-asset-bess border-violet-200',
    label: 'BESS',
  },
};

function AssetChip({ assetType }: { assetType: AssetType }) {
  const a = ASSET_CHIP[assetType];
  return (
    <span
      className={`hidden sm:inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] ${a.chip}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${a.dot}`} />
      {a.label}
    </span>
  );
}

interface PlantInfo {
  plantId: string;
  plantName: string;
  location: string;
  capacity_MW: number;
  capacityMwh?: number;
  chemistry?: string;
  market?: string;
  totalInverters?: number;
  turbineCount?: number;
  assetType?: AssetType;
  dataRange?: {
    start: string;
    end: string;
  } | null;
}

// Navigation item definitions (labels resolved via t() in component).
// All items are route-based since the hash→route migration: `route: ''`
// is the plant overview, anything else appends `/<route>` to the plant URL.
const solarNavKeys = [
  { route: '', labelKey: 'nav.overview', icon: LayoutGrid },
  { route: 'financials', labelKey: 'nav.financials', icon: DollarSign },
  { route: 'faults', labelKey: 'nav.faultDetection', icon: AlertTriangle },
  { route: 'soiling', labelKey: 'nav.soiling', icon: Droplets },
  { route: 'bess', labelKey: 'nav.batteryStorage', icon: Battery },
  { route: 'maintenance-horizon', labelKey: 'nav.maintenanceHorizon', icon: CalendarClock },
  { route: 'quality', labelKey: 'nav.dataQuality', icon: Shield },
  { route: 'tickets', labelKey: 'nav.tickets', icon: Ticket },
  { route: 'datahub', labelKey: 'nav.dataHub', icon: Database },
  { route: 'settings', labelKey: 'nav.settings', icon: Settings },
];

// Wind dashboards render power-curve and predictive content inside the
// overview WindSection, so the nav stays lean.
const windNavKeys = [
  { route: '', labelKey: 'nav.overview', icon: LayoutGrid },
  { route: 'financials', labelKey: 'nav.financials', icon: DollarSign },
  { route: 'quality', labelKey: 'nav.dataQuality', icon: Shield },
  { route: 'tickets', labelKey: 'nav.tickets', icon: Ticket },
  { route: 'datahub', labelKey: 'nav.dataHub', icon: Database },
  { route: 'settings', labelKey: 'nav.settings', icon: Settings },
];

// BESS plants route `Overview` straight to the BESS dashboard (warranty /
// cycling / dispatch tabs are inside BessSection on the overview route).
const bessNavKeys = [
  { route: '', labelKey: 'nav.overview', icon: Battery },
  { route: 'revenue', labelKey: 'nav.revenue', icon: DollarSign },
  { route: 'financials', labelKey: 'nav.financials', icon: DollarSign },
  { route: 'tickets', labelKey: 'nav.tickets', icon: Ticket },
  { route: 'quality', labelKey: 'nav.dataQuality', icon: Shield },
  { route: 'datahub', labelKey: 'nav.dataHub', icon: Database },
  { route: 'settings', labelKey: 'nav.settings', icon: Settings },
];

// Audit product surface (parallel to the Monitor surface above). Shown when
// the pathname sits under `/plant/[plantId]/audit`. BESS / hybrid assets only.
const auditNavKeys = [
  { route: 'audit', labelKey: 'nav.auditOverview', icon: LayoutGrid },
  { route: 'audit/optimizer', labelKey: 'nav.auditOptimizer', icon: Gauge },
  { route: 'audit/warranty', labelKey: 'nav.auditWarranty', icon: FileCheck },
  { route: 'audit/compliance', labelKey: 'nav.auditCompliance', icon: Scale },
];

/**
 * Monitor | Audit segmented control. Pure client-side navigation via
 * next/link, keeps the current plant + surface (/demo vs /showcase) intact.
 */
function ModeSwitch({
  routePrefix,
  plantId,
  isAudit,
  className = '',
}: {
  routePrefix: string;
  plantId: string;
  isAudit: boolean;
  className?: string;
}) {
  const base = `${routePrefix}/plant/${plantId}`;
  const seg = (active: boolean) =>
    `flex-1 text-center rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
      active ? 'bg-white text-blue-700 shadow-sm' : 'text-ink-2 hover:text-ink'
    }`;
  return (
    <div
      className={`inline-flex items-center rounded-lg border border-divider bg-gray-100 p-0.5 ${className}`}
      role="tablist"
      aria-label="Product mode"
    >
      <Link href={base} role="tab" aria-selected={!isAudit} className={seg(!isAudit)}>
        Monitor
      </Link>
      <Link href={`${base}/audit`} role="tab" aria-selected={isAudit} className={seg(isAudit)}>
        Audit
      </Link>
    </div>
  );
}

interface PlantPageChromeProps {
  children: ReactNode;
  /** Base route for portfolio/plant/inverter links. Either `/demo` or `/showcase`. */
  routePrefix: '/dashboard' | '/demo' | '/showcase';
  /** Pill text in the header. Defaults to "Demo Mode". */
  modeLabel?: string;
  /** When false, skip rendering the top header (parent layout owns it). */
  renderHeader?: boolean;
}

export default function PlantPageChrome({
  children,
  routePrefix,
  modeLabel = 'Demo Mode',
  renderHeader = true,
}: PlantPageChromeProps) {
  const pathname = usePathname();
  const params = useParams();
  const router = useRouter();
  const plantId = params.plantId as string;

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { anonName } = useAnonymization();
  const { plants } = useDemoPlants();
  const { groups: plantGroups } = usePlantGroups(plantId);
  const { t } = useLanguage();

  const apiPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  const plantInfo: PlantInfo | null = apiPlant
    ? {
        plantId: apiPlant.slug,
        plantName: apiPlant.name,
        location: apiPlant.location_name || '',
        capacity_MW: apiPlant.capacity_mw,
        capacityMwh: apiPlant.capacity_mwh,
        chemistry: apiPlant.chemistry,
        market: apiPlant.market,
        totalInverters: apiPlant.inverter_count,
        assetType: (apiPlant.asset_type === 'PV' ? 'SOLAR' : apiPlant.asset_type) as AssetType,
      }
    : null;

  const handlePlantChange = useCallback(
    (newPlantId: string) => {
      // Preserve the current section route when switching plants, e.g.
      // /demo/plant/alpha/soiling → /demo/plant/ribera/soiling.
      // Allows up to two segments so nested audit routes survive the switch.
      const m = pathname.match(/\/plant\/[^/]+((?:\/[a-z-]+){0,2})$/);
      const sectionSuffix = m?.[1] ?? '';
      const currentParams = new URLSearchParams(window.location.search);
      const queryString = currentParams.toString();
      const newUrl = `${routePrefix}/plant/${newPlantId}${sectionSuffix}${queryString ? `?${queryString}` : ''}`;
      router.push(newUrl);
    },
    [router, routePrefix, pathname],
  );

  const isInverterPage = pathname.includes('/inverter/');

  // Audit surface availability + detection. The Audit product exists for
  // BESS and hybrid (PV+BESS) assets; solar-only plants keep Monitor only.
  const plantChip = apiPlant ? assetTypeChip(apiPlant.asset_type) : null;
  const supportsAudit = plantChip === 'BESS' || plantChip === 'PV+BESS';
  const isAuditMode =
    supportsAudit && /\/plant\/[^/]+\/audit(\/|$)/.test(pathname ?? '');

  const navItems = useMemo(() => {
    if (isAuditMode) return auditNavKeys;
    const assetType = plantInfo?.assetType || 'SOLAR';
    if (assetType === 'WIND') return windNavKeys;
    if (assetType === 'BESS') return bessNavKeys;
    return solarNavKeys;
  }, [plantInfo?.assetType, isAuditMode]);

  const portfolioHref = `${routePrefix}/portfolio`;

  return (
    <div className="min-h-screen bg-paper">
      {renderHeader && (
        <header className="bg-paper shadow-sm border-b border-divider sticky top-0 z-50">
          <div className="max-w-[1920px] mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2 md:gap-4">
              {/* Mobile hamburger menu */}
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="md:hidden p-2 hover:bg-gray-100 rounded-lg transition-colors"
                aria-label="Toggle menu"
              >
                {mobileMenuOpen ? (
                  <X className="w-6 h-6 text-ink-2" />
                ) : (
                  <Menu className="w-6 h-6 text-ink-2" />
                )}
              </button>

              <Link href={portfolioHref} className="flex items-center">
                <NuraVoltLogo width={140} height={35} showTagline={false} />
              </Link>
              <span className="hidden sm:inline px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded-full border border-blue-300 font-medium">
                {modeLabel}
              </span>
              {plantInfo?.assetType && (
                <AssetChip assetType={plantInfo.assetType} />
              )}
              {supportsAudit && (
                <ModeSwitch
                  routePrefix={routePrefix}
                  plantId={plantId}
                  isAudit={isAuditMode}
                  className="hidden sm:inline-flex"
                />
              )}
            </div>

            <div className="flex items-center gap-4">
              <LanguageSwitcher variant="compact" />
              <AnonymizationToggle variant="compact" />
              <PlantSelector
                currentPlantId={plantId}
                onPlantChange={handlePlantChange}
                routePrefix={routePrefix}
              />
            </div>
          </div>
        </header>
      )}

      <div className="flex relative">
        {mobileMenuOpen && (
          <div
            className="fixed inset-0 bg-black/50 z-40 md:hidden"
            onClick={() => setMobileMenuOpen(false)}
          />
        )}

        {!isInverterPage && (
          <aside
            className={`
              fixed md:sticky top-[65px] left-0 w-[200px] md:w-[220px] lg:w-64 h-[calc(100vh-65px)]
              bg-white border-r border-divider z-50 overflow-y-auto
              transition-transform duration-300 ease-in-out flex-shrink-0
              ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
            `}
          >
            <nav className="p-3 md:p-4 space-y-1">
              <Link
                href={portfolioHref}
                className="w-full flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2.5 md:py-3 rounded-lg transition-all text-ink-2 hover:bg-gray-100"
              >
                <LayoutDashboard className="w-5 h-5 flex-shrink-0" />
                <span className="font-medium text-sm md:text-base truncate">{t('nav.portfolioOverview')}</span>
              </Link>

              <div className="pt-4 pb-2 px-3 md:px-4">
                <div className="text-xs font-semibold text-ink-3 uppercase tracking-wider truncate">
                  {anonName(plantInfo?.plantName || 'Plant')}
                </div>
              </div>

              {supportsAudit && (
                <div className="px-3 md:px-4 pb-2">
                  <ModeSwitch
                    routePrefix={routePrefix}
                    plantId={plantId}
                    isAudit={isAuditMode}
                    className="flex w-full"
                  />
                </div>
              )}

              {navItems.map((item) => {
                const { route, labelKey, icon: Icon } = item;
                const label = t(labelKey);
                const base = `${routePrefix}/plant/${plantId}`;
                const href = route ? `${base}/${route}` : base;
                const isActive = route
                  ? pathname.endsWith(`/${route}`)
                  : pathname === base || pathname === `${base}/`;
                const dataTour =
                  route === 'faults'
                    ? 'nav-faults'
                    : route === 'soiling'
                      ? 'nav-soiling'
                      : undefined;
                return (
                  <Link
                    key={route || 'overview'}
                    href={href}
                    data-tour={dataTour}
                    className={`w-full flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2.5 md:py-3 rounded-lg transition-all ${
                      isActive
                        ? 'bg-blue-100 text-blue-700 border-l-4 border-blue-600'
                        : 'text-ink-2 hover:bg-gray-100'
                    }`}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    <Icon className="w-5 h-5 flex-shrink-0" />
                    <span className="font-medium text-sm md:text-base whitespace-nowrap">{label}</span>
                  </Link>
                );
              })}
            </nav>

            {plantInfo && (
              <div
                className={`mx-3 md:mx-4 mt-4 p-3 md:p-4 rounded-lg border ${
                  plantInfo.assetType === 'WIND'
                    ? 'bg-cyan-50 border-cyan-200'
                    : plantInfo.assetType === 'BESS'
                      ? 'bg-violet-50 border-violet-200'
                      : 'bg-blue-50 border-blue-200'
                }`}
              >
                <h3 className="text-xs md:text-sm font-semibold text-ink-2 mb-2 md:mb-3 flex items-center gap-2">
                  {plantInfo.assetType === 'WIND' && <Wind className="h-4 w-4 text-cyan-600" />}
                  {plantInfo.assetType === 'BESS' && <Battery className="h-4 w-4 text-violet-600" />}
                  {t('common.plantStatus')}
                </h3>
                <div className="space-y-1.5 md:space-y-2">
                  {plantInfo.assetType === 'WIND' && (
                    <div className="flex justify-between text-xs">
                      <span className="text-ink-2">Turbines</span>
                      <span className="text-ink font-medium">{plantInfo.turbineCount || 0}</span>
                    </div>
                  )}
                  {plantInfo.assetType === 'BESS' && plantInfo.chemistry && (
                    <div className="flex justify-between text-xs">
                      <span className="text-ink-2">Chemistry</span>
                      <span className="text-ink font-medium">{plantInfo.chemistry}</span>
                    </div>
                  )}
                  {plantInfo.assetType !== 'WIND' && plantInfo.assetType !== 'BESS' && (
                    <div className="flex justify-between text-xs">
                      <span className="text-ink-2">Inverters</span>
                      <span className="text-ink font-medium">{plantInfo.totalInverters}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-xs">
                    <span className="text-ink-2">{plantInfo.assetType === 'BESS' ? 'Power' : 'Capacity'}</span>
                    <span className="text-ink font-medium">{plantInfo.capacity_MW} MW</span>
                  </div>
                  {plantInfo.assetType === 'BESS' && plantInfo.capacityMwh && (
                    <div className="flex justify-between text-xs">
                      <span className="text-ink-2">Energy</span>
                      <span className="text-ink font-medium">{plantInfo.capacityMwh} MWh</span>
                    </div>
                  )}
                  {plantInfo.assetType === 'BESS' && plantInfo.market && (
                    <div className="flex justify-between text-xs">
                      <span className="text-ink-2">Market</span>
                      <span className="text-ink font-medium">{plantInfo.market}</span>
                    </div>
                  )}
                  {plantGroups.length > 0 && (
                    <div className="pt-1.5 mt-1.5 border-t border-gray-200/50">
                      <span className="text-xs text-ink-3 font-medium">Groups</span>
                      <div className="mt-1 space-y-1">
                        {plantGroups.map((g) => (
                          <div key={g.id} className="flex justify-between text-xs">
                            <span className="text-ink-2 truncate mr-2">{g.name}</span>
                            <span className="text-ink font-medium whitespace-nowrap">
                              {g.inverterCount}× · {g.azimuth}°/{g.tilt}°
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {plantInfo.dataRange && (
                    <div className="flex justify-between text-xs">
                      <span className="text-ink-2">Data Range</span>
                      <span className="text-ink font-medium">
                        {new Date(plantInfo.dataRange.start).getFullYear()}-
                        {new Date(plantInfo.dataRange.end).getFullYear()}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </aside>
        )}

        <main
          className={`flex-1 p-4 md:p-6 max-w-[1600px] bg-paper w-full ${
            isInverterPage ? '' : 'md:w-auto'
          }`}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
