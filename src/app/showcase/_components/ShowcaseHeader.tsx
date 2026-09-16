'use client';

/**
 * ShowcaseTopBar, sticky header shown on every `/showcase/*` route.
 *
 * Mirrors the demo plant-page header visually (logo, mode pill, language
 * switcher, anonymization toggle, plant selector) so the showcase feels like
 * a single product surface. On plant pages, `PlantPageChrome` is mounted with
 * `renderHeader={false}` so this bar is not duplicated.
 */

import Link from 'next/link';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname, useParams, useRouter } from 'next/navigation';
import NuraVoltLogo from '@/components/NuraVoltLogo';
import PlantSelector from '@/components/PlantSelector';
import AnonymizationToggle from '@/components/demo/AnonymizationToggle';
import LanguageSwitcher from '@/components/LanguageSwitcher';

// Same modal the marketing homepage uses. Dynamic so the bundle stays light
// when nobody clicks "Book a call".
const BookingModal = dynamic(() => import('@/components/landing/BookingModal'));

export default function ShowcaseHeader() {
  const pathname = usePathname();
  const params = useParams();
  const router = useRouter();
  const [isBookingOpen, setIsBookingOpen] = useState(false);

  // Plant selector only makes sense on plant pages.
  const isPlantPage = pathname?.startsWith('/showcase/plant/');
  const plantId = (params?.plantId as string) || '';

  const handlePlantChange = (newPlantId: string) => {
    router.push(`/showcase/plant/${newPlantId}`);
  };

  return (
    <header className="bg-paper shadow-sm border-b border-divider sticky top-0 z-50">
      <div className="max-w-[1920px] mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2 md:gap-4">
          <Link href="/showcase/portfolio" className="flex items-center">
            <NuraVoltLogo width={140} height={35} showTagline={false} />
          </Link>
          <span className="hidden sm:inline px-2 py-1 bg-signal-warning/10 text-signal-warning text-xs rounded-full border border-signal-warning/30 font-medium">
            Showcase · Sample Data
          </span>
        </div>

        <div className="flex items-center gap-3 md:gap-4">
          <Link
            href="/showcase/portfolio"
            className="hidden md:inline text-sm text-ink-2 hover:text-blue-600 transition-colors"
          >
            Portfolio
          </Link>
          <Link
            href="/showcase/reports"
            className="hidden md:inline text-sm text-ink-2 hover:text-blue-600 transition-colors"
          >
            Reports
          </Link>
          <Link
            href="/"
            className="hidden lg:inline text-sm text-ink-2 hover:text-blue-600 transition-colors"
          >
            ← Main site
          </Link>
          <LanguageSwitcher variant="compact" />
          <AnonymizationToggle variant="compact" />
          {isPlantPage && plantId && (
            <PlantSelector
              currentPlantId={plantId}
              onPlantChange={handlePlantChange}
              routePrefix="/showcase"
            />
          )}
          <button
            type="button"
            onClick={() => setIsBookingOpen(true)}
            className="ml-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium hidden sm:inline"
          >
            Book a call
          </button>
        </div>
      </div>

      <BookingModal
        isOpen={isBookingOpen}
        onClose={() => setIsBookingOpen(false)}
      />
    </header>
  );
}
