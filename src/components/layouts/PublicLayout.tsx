import { ReactNode } from 'react';
import BackToTopButton from '@/components/BackToTopButton';
import Footer from '@/components/Footer';
import MarketingHeader from '@/components/layouts/MarketingHeader';

interface PublicLayoutProps {
  children: ReactNode;
}

/**
 * PublicLayout, universal wrapper for every public marketing page.
 *
 * Provides the canonical MarketingHeader (single source of truth for nav),
 * a <main> for page content, the shared Footer, and a back-to-top button.
 *
 * Pages that need different chrome (dashboard, demo, showcase, chat) have
 * their own dedicated layouts; everything else routed under /(public-ish)
 * should wrap in <PublicLayout> to inherit the nav.
 */
export default function PublicLayout({ children }: PublicLayoutProps) {
  return (
    <div className="min-h-screen bg-paper">
      <MarketingHeader />
      <main>{children}</main>
      <Footer />
      <BackToTopButton />
    </div>
  );
}
