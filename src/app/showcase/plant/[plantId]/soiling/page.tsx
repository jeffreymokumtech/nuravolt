'use client';

/**
 * Showcase soiling section, delegates to the /demo route body. The showcase
 * layout provides DataSourceContext (dataRoot='/data/showcase') so the same
 * section component renders against showcase data without modification.
 */
import DemoPage from '@/app/demo/plant/[plantId]/soiling/page';

export default function ShowcaseSoilingPage() {
  return <DemoPage />;
}
