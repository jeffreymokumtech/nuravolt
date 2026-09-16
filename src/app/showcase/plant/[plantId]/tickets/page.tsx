'use client';

/**
 * Showcase tickets section, delegates to the /demo route body. The showcase
 * layout provides DataSourceContext (dataRoot='/data/showcase') so the same
 * section component renders against showcase data without modification.
 */
import DemoPage from '@/app/demo/plant/[plantId]/tickets/page';

export default function ShowcaseTicketsPage() {
  return <DemoPage />;
}
