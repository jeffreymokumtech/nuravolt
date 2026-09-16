import { MetadataRoute } from 'next';
import { SITE_URL } from '@/libs/seo';

/**
 * robots.txt, allow indexing of all public marketing pages, keep the
 * authenticated/app surfaces out of the index, and point crawlers at the
 * sitemap. Next.js serves this at /robots.txt.
 *
 * AI crawlers get an explicit allow stanza (same disallow list). The wildcard
 * already permits them; being explicit signals the content is intentionally
 * available to AI search and answer engines (GEO).
 */
const DISALLOW = ['/dashboard', '/demo', '/chat', '/sign-in', '/sign-up', '/api'];

const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'CCBot',
  'meta-externalagent',
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: DISALLOW },
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, allow: '/', disallow: DISALLOW })),
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
