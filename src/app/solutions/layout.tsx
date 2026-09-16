import PublicLayout from '@/components/layouts/PublicLayout';

/**
 * Solutions sub-layout, just defers to the universal PublicLayout so the
 * BESS / PV / Wind solution pages inherit the canonical MarketingHeader.
 */
export default function SolutionsLayout({ children }: { children: React.ReactNode }) {
  return <PublicLayout>{children}</PublicLayout>;
}
