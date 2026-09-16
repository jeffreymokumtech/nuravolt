import { MetadataRoute } from 'next'
import {wordpressService} from "@/libs/wp";
import { SITE_URL } from '@/libs/seo'
import { faults } from '@/data/content/faults'
import { bessMetrics } from '@/data/content/bessMetrics'
import { pvMetrics } from '@/data/content/pvMetrics'
import { integrations } from '@/data/content/integrations'
import { insights } from '@/data/content/insights'
import { reports } from '@/data/content/reports'
import { comparisons } from '@/data/content/comparisons'
import { regions } from '@/data/content/regions'
import { DOC_ARTICLES } from '@/data/docs'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    // Sitemaps require absolute URLs. NEXT_PUBLIC_APP_URL is unset in prod, so
    // fall back to the canonical SITE_URL rather than emitting relative paths.
    const currentUrl = (process.env.NEXT_PUBLIC_APP_URL || SITE_URL).replace(/\/$/, '')

    const posts = await wordpressService.getPostsForSitemap().then(resp => resp).catch(():any[] => [])

    const blogPostsMaps: MetadataRoute.Sitemap = posts.map((post) => ({
        url: `${currentUrl}/blog/${post.slug}`,
            lastModified: new Date('2026-06-15'),
            changeFrequency: 'yearly',
            priority: 0.4,
    }))

    // Per-page lastModified gives Google an honest, stable freshness signal, // using `new Date()` everywhere makes every URL look freshly changed on
    // every build, which tells the crawler nothing. Catalog pages carry their
    // own datePublished; hubs and blog posts use real authored dates.
    const HUB_UPDATED = new Date('2026-06-15')
    // Top-level static pages last changed in the 2026-07 ship (reports links,
    // MCP launch, billing). Fixed date instead of new Date() so freshness is
    // honest and stable across rebuilds.
    const STATIC_UPDATED = new Date('2026-07-07')
    const lastMod = (d?: string) => new Date(d || '2026-06-15')
    const blogDates: Record<string, string> = {
        'bms-monitoring-not-enough-2026': '2026-06-15',
        'augment-vs-overbuild': '2026-06-15',
        'clipping-hides-soiling': '2026-06-15',
        'leading-with-bess-2026': '2026-06-10',
        'iberian-blackout-bess-readiness': '2026-06-10',
        'soiling-season-field-note': '2026-06-10',
        'bess-faults-ml-adds-value': '2025-10-01',
        'cost-of-poor-irradiation-data': '2025-10-01',
    }

    // Programmatic content catalog (Templates A,E). BESS leads the offering,
    // so its hub and pages carry the highest content priority.
    const contentMaps: MetadataRoute.Sitemap = [
        { url: `${currentUrl}/bess`, changeFrequency: 'monthly', priority: 0.8, lastModified: HUB_UPDATED }, ...bessMetrics.map((m) => ({ url: `${currentUrl}/bess/${m.slug}`, changeFrequency: 'monthly' as const, priority: 0.7, lastModified: lastMod(m.datePublished) })),
        { url: `${currentUrl}/pv-metrics`, changeFrequency: 'monthly', priority: 0.7, lastModified: HUB_UPDATED }, ...pvMetrics.map((m) => ({ url: `${currentUrl}/pv-metrics/${m.slug}`, changeFrequency: 'monthly' as const, priority: 0.6, lastModified: lastMod(m.datePublished) })),
        { url: `${currentUrl}/faults`, changeFrequency: 'monthly', priority: 0.7, lastModified: HUB_UPDATED }, ...faults.map((f) => ({ url: `${currentUrl}/faults/${f.slug}`, changeFrequency: 'monthly' as const, priority: 0.6, lastModified: lastMod(f.datePublished) })),
        { url: `${currentUrl}/integrations`, changeFrequency: 'monthly', priority: 0.7, lastModified: HUB_UPDATED }, ...integrations.map((i) => ({ url: `${currentUrl}/integrations/${i.slug}`, changeFrequency: 'monthly' as const, priority: 0.6, lastModified: lastMod(i.datePublished) })),
        { url: `${currentUrl}/insights`, changeFrequency: 'monthly', priority: 0.6, lastModified: HUB_UPDATED }, ...insights.map((i) => ({ url: `${currentUrl}/insights/${i.slug}`, changeFrequency: 'monthly' as const, priority: 0.5, lastModified: lastMod(i.datePublished) })),
        // Original data reports, the linkable/citable assets. Higher priority than
        // reference pages because these are what earns backlinks.
        { url: `${currentUrl}/reports`, changeFrequency: 'monthly', priority: 0.8, lastModified: HUB_UPDATED }, ...reports.map((r) => ({ url: `${currentUrl}/reports/${r.slug}`, changeFrequency: 'monthly' as const, priority: 0.7, lastModified: lastMod(r.datePublished) })),
        // Comparison pages and country guides (2026-07 batch): query-targeted
        // pages, so they sit above the reference catalogs in priority.
        { url: `${currentUrl}/compare`, changeFrequency: 'monthly', priority: 0.7, lastModified: STATIC_UPDATED }, ...comparisons.map((c) => ({ url: `${currentUrl}/compare/${c.slug}`, changeFrequency: 'monthly' as const, priority: 0.6, lastModified: lastMod(c.datePublished) })),
        { url: `${currentUrl}/solar-monitoring`, changeFrequency: 'monthly', priority: 0.7, lastModified: STATIC_UPDATED }, ...regions.map((r) => ({ url: `${currentUrl}/solar-monitoring/${r.slug}`, changeFrequency: 'monthly' as const, priority: 0.6, lastModified: lastMod(r.datePublished) })),
        // Static (repo-authored) blog posts. WordPress is disabled, so these
        // are listed explicitly rather than via the WP feed above.
        ...Object.keys(blogDates).map((slug) => ({
            url: `${currentUrl}/blog/${slug}`,
            changeFrequency: 'monthly' as const,
            priority: 0.5,
            lastModified: new Date(blogDates[slug]),
        })),
    ]

    return [
        {
            url: currentUrl,
            lastModified: STATIC_UPDATED,
            changeFrequency: 'yearly',
            priority: 1,
        },
        // BESS leads the offering, make sure it's the highest-priority
        // non-home page in the sitemap.
        {
            url: `${currentUrl}/solutions/bess-monitoring`,
            lastModified: STATIC_UPDATED,
            changeFrequency: 'monthly',
            priority: 0.9,
        },
        // Audit is the parallel one-off product line next to Monitor.
        {
            url: `${currentUrl}/solutions/audit`,
            lastModified: STATIC_UPDATED,
            changeFrequency: 'monthly',
            priority: 0.85,
        },
        {
            url: `${currentUrl}/engagements`,
            lastModified: STATIC_UPDATED,
            changeFrequency: 'monthly',
            priority: 0.85,
        },
        {
            url: `${currentUrl}/pricing`,
            lastModified: STATIC_UPDATED,
            changeFrequency: 'monthly',
            priority: 0.85,
        },
        {
            url: `${currentUrl}/docs`,
            lastModified: HUB_UPDATED,
            changeFrequency: 'weekly',
            priority: 0.8,
        },
        ...DOC_ARTICLES.map((article) => ({
            url: `${currentUrl}/docs/${article.category}/${article.slug}`,
            lastModified: lastMod(article.datePublished),
            changeFrequency: 'monthly' as const,
            priority: 0.6,
        })),
        // MCP server launch pages (2026-07). Previously missing from the sitemap.
        {
            url: `${currentUrl}/mcp`,
            lastModified: STATIC_UPDATED,
            changeFrequency: 'monthly',
            priority: 0.8,
        },
        {
            url: `${currentUrl}/mcp/setup`,
            lastModified: STATIC_UPDATED,
            changeFrequency: 'monthly',
            priority: 0.6,
        },
        {
            url: `${currentUrl}/compliance/reference`,
            lastModified: HUB_UPDATED,
            changeFrequency: 'monthly',
            priority: 0.7,
        },
        {
            url: `${currentUrl}/roi-calculator`,
            lastModified: HUB_UPDATED,
            changeFrequency: 'monthly',
            priority: 0.6,
        },
        {
            url: `${currentUrl}/solutions/pv-monitoring`,
            lastModified: STATIC_UPDATED,
            changeFrequency: 'monthly',
            priority: 0.75,
        },
        {
            url: `${currentUrl}/solutions/wind-monitoring`,
            lastModified: STATIC_UPDATED,
            changeFrequency: 'monthly',
            priority: 0.6,
        },
        {
            url: `${currentUrl}/about`,
            lastModified: STATIC_UPDATED,
            changeFrequency: 'yearly',
            priority: 0.6,
        },
        {
            url: `${currentUrl}/case-studies`,
            lastModified: STATIC_UPDATED,
            changeFrequency: 'monthly',
            priority: 0.6,
        },
        {
            url: `${currentUrl}/resources`,
            lastModified: STATIC_UPDATED,
            changeFrequency: 'monthly',
            priority: 0.6,
        },
        {
            url: `${currentUrl}/blog`,
            lastModified: STATIC_UPDATED,
            changeFrequency: 'weekly',
            priority: 0.55,
        },
        {
            url: `${currentUrl}/privacy-policy`,
            lastModified: STATIC_UPDATED,
            changeFrequency: 'yearly',
            priority: 0.4,
        },
        {
            url: `${currentUrl}/tos`,
            lastModified: STATIC_UPDATED,
            changeFrequency: 'yearly',
            priority: 0.4,
        },
        ...contentMaps,
        ...blogPostsMaps
    ]
}