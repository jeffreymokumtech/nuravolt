'use client';

import dynamic from 'next/dynamic';
import SectionSkeleton from '@/components/SectionSkeleton';
import OpsLegacyWrapper from '@/components/ops/OpsLegacyWrapper';

const SettingsSection = dynamic(
  () => import('@/app/demo/_components/SettingsSection'),
  { loading: () => <SectionSkeleton title="Loading Settings..." />, ssr: false },
);

export default function SettingsPage() {
  return (
    <OpsLegacyWrapper
      activeNavKey="settings"
      section="SETTINGS"
      panelLabel="PLANT.settings"
      panelMeta="thresholds · alerts · access"
    >
      <SettingsSection />
    </OpsLegacyWrapper>
  );
}
