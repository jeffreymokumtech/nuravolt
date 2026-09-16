import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import PublicLayout from '@/components/layouts/PublicLayout';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { HairlineRule } from '@/components/ui/HairlineRule';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import { getSEOTags, buildBreadcrumbSchema } from '@/libs/seo';
import { DOC_CATEGORIES, docsByCategory } from '@/data/docs';
import { docUrl } from '@/data/docs/types';

export const metadata = getSEOTags({
  title: 'Documentation | NuraVolt',
  description:
    'How to use NuraVolt: onboarding your first plant, connecting inverter clouds and SCADA, soiling and fault analytics, team roles, billing, and the MCP server for AI assistants.',
  canonicalUrlRelative: '/docs',
  keywords: [
    'NuraVolt documentation',
    'solar monitoring setup',
    'FusionSolar integration guide',
    'SolarEdge API guide',
    'soiling analytics docs',
  ],
});

export default function DocsHubPage() {
  return (
    <PublicLayout>
      <main>
        <SchemaJsonLd
        data={[
          buildBreadcrumbSchema([
            { name: 'Home', urlRelative: '/' },
            { name: 'Documentation', urlRelative: '/docs' },
          ]),
        ]}
      />

      <MarketingSection size="hero" surface="paper">
        <div className="max-w-3xl">
          <p className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            Documentation
          </p>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
            Learn NuraVolt
          </h1>
          <p className="text-lg opacity-80">
            From first sign-in to fleet-wide analytics. Short, factual guides for
            everything in the platform.
          </p>
        </div>
      </MarketingSection>

      <HairlineRule />

      <MarketingSection surface="paper-2">
        <div className="grid gap-8 md:grid-cols-2 max-w-5xl mx-auto">
          {DOC_CATEGORIES.map((category) => {
            const articles = docsByCategory(category.slug);
            return (
              <section
                key={category.slug}
                className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm"
              >
                <h2 className="text-lg font-semibold text-gray-900">{category.label}</h2>
                <p className="mt-1 text-sm text-gray-600">{category.description}</p>
                <ul className="mt-4 space-y-2">
                  {articles.map((article) => (
                    <li key={article.slug}>
                      <Link
                        href={docUrl(article.category, article.slug)}
                        className="group inline-flex items-start gap-1.5 text-sm text-blue-700 hover:text-blue-900"
                      >
                        <ArrowRight className="h-3.5 w-3.5 mt-0.5 shrink-0 opacity-60 group-hover:translate-x-0.5 transition-transform" />
                        {article.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>

        <p className="text-center text-sm opacity-70 mt-10">
          Can&apos;t find what you need? Ask the in-app AI assistant, or write to{' '}
          <a href="mailto:contact@nuravolt.com" className="underline">
            contact@nuravolt.com
          </a>
          .
        </p>
      </MarketingSection>
      </main>
    </PublicLayout>
  );
}
