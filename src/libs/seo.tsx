import type { Metadata } from "next";
import config from "@/config";
import {AbsoluteString, DefaultTemplateString} from "next/dist/lib/metadata/types/metadata-types";

// These are all the SEO tags you can add to your pages.
// It prefills data with default title/description/OG, etc.. and you can cusotmize it for each page.
// It's already added in the root layout.js so you don't have to add it to every pages
// But I recommend to set the canonical URL for each page (export const metadata = getSEOTags({canonicalUrlRelative: "/"});)
// See https://micro.st/docs/features/seo

export const getSEOTags = ({
  title,
  description,
  keywords,
  openGraph,
  canonicalUrlRelative,
  extraTags,
}: Metadata & {
  canonicalUrlRelative?: string;
  extraTags?: Record<string, any>;
} = {}) => {
  return {
    // up to 50 characters (what does your app do for the user?) > your main should be here
    title: title || config.appName,
    // up to 160 characters (how does your app help the user?)
    description: description || config.appDescription,
    // some keywords separated by commas. by default it will be your app name
    keywords: keywords || [config.appName],
    applicationName: config.appName,
    // set a base URL prefix for other fields that require a fully qualified URL (.e.g og:image: og:image: 'https://yourdomain.com/share.png' => '/share.png')
    metadataBase: new URL(
      process.env.NODE_ENV === "development"
        ? "http://localhost:3000/"
        : `https://${config.domainName}/`
    ),
    openGraph: {
      // Default OG title/description/url to the PER-PAGE values so shared links
      // (LinkedIn/Slack/X) show the page, not the generic homepage card.
      // siteName is always the brand; metadataBase resolves the relative url.
      title: openGraph?.title || title || config.appName,
      description: openGraph?.description || description || config.appDescription,
      url: openGraph?.url || canonicalUrlRelative || `https://${config.domainName}/`,
      siteName: config.appName,
      images: [
        {
          url: '/og-image.png',
          width: 1200,
          height: 630,
          alt: 'NuraVolt - Energy Intelligence for Solar & Storage',
        },
      ],
      locale: "en_US",
      type: "website",
    },
    twitter: {
      title: openGraph?.title || title || config.appName,
      description: openGraph?.description || description || config.appDescription,
      images: ['/og-image.png'],
      card: "summary_large_image",
    },
    // If a canonical URL is given, we add it. The metadataBase will turn the relative URL into a fully qualified URL
    ...(canonicalUrlRelative && {
      alternates: { canonical: canonicalUrlRelative },
    }),
    // If you want to add extra tags, you can pass them here
    ...extraTags,
  };
};

// ---------------------------------------------------------------------------
// JSON-LD schema builders (pure objects) for the content catalog.
//
// These return plain schema.org objects — render them with <SchemaJsonLd />.
// AI search engines (ChatGPT/Perplexity/Claude) and Google rich results both
// lift structured data, so every content page ships TechArticle + FAQPage +
// BreadcrumbList, and the site ships a single site-wide Organization.
// Validate with https://search.google.com/test/rich-results
// ---------------------------------------------------------------------------

/** Naked production origin, e.g. https://nuravolt.com (no trailing slash). */
export const SITE_URL = `https://${config.domainName}`;

/** Turn a relative path ("/bess/state-of-health") into a fully-qualified URL. */
export const absoluteUrl = (path: string) =>
  `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;

/** Site-wide Organization — mount once in the root layout. */
export const buildOrganizationSchema = () => ({
  "@context": "https://schema.org",
  "@type": "Organization",
  name: config.appName,
  url: `${SITE_URL}/`,
  logo: `${SITE_URL}/og-image.png`,
  description: config.appDescription,
  sameAs: ["https://www.linkedin.com/company/nuravolt"],
});

/**
 * SoftwareApplication for the product itself — mount on the homepage only.
 * Deliberately carries NO aggregateRating and NO offers: we have no public
 * review corpus and pricing is engagement-based, so declaring either would
 * be fabricated data. Add them only when real, verifiable values exist.
 */
export const buildSoftwareApplicationSchema = () => ({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: config.appName,
  description: config.appDescription,
  url: `${SITE_URL}/`,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  publisher: { "@type": "Organization", name: config.appName, url: `${SITE_URL}/` },
});

/** Site-wide WebSite entity — mount once in the root layout. */
export const buildWebsiteSchema = () => ({
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: config.appName,
  url: `${SITE_URL}/`,
  description: config.appDescription,
  publisher: { "@type": "Organization", name: config.appName },
  inLanguage: "en",
});

/**
 * TechArticle for a content page. We use TechArticle (not Article) because the
 * catalog is technical reference material on PV/BESS engineering topics.
 */
export const buildArticleSchema = ({
  title,
  description,
  urlRelative,
  datePublished,
  dateModified,
  image,
}: {
  title: string;
  description: string;
  urlRelative: string;
  datePublished?: string;
  dateModified?: string;
  image?: string;
}) => ({
  "@context": "https://schema.org",
  "@type": "TechArticle",
  headline: title,
  description,
  url: absoluteUrl(urlRelative),
  mainEntityOfPage: { "@type": "WebPage", "@id": absoluteUrl(urlRelative) },
  image: image ? absoluteUrl(image) : `${SITE_URL}/og-image.png`,
  ...(datePublished && { datePublished }),
  dateModified: dateModified || datePublished || undefined,
  author: { "@type": "Organization", name: config.appName },
  publisher: {
    "@type": "Organization",
    name: config.appName,
    logo: { "@type": "ImageObject", url: `${SITE_URL}/og-image.png` },
  },
});

/** FAQPage from a list of question/answer pairs. */
export const buildFAQSchema = (faqs: { q: string; a: string }[]) => ({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map(({ q, a }) => ({
    "@type": "Question",
    name: q,
    acceptedAnswer: { "@type": "Answer", text: a },
  })),
});

/** BreadcrumbList from an ordered list of {name, urlRelative} crumbs. */
export const buildBreadcrumbSchema = (
  items: { name: string; urlRelative: string }[]
) => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: items.map((item, i) => ({
    "@type": "ListItem",
    position: i + 1,
    name: item.name,
    item: absoluteUrl(item.urlRelative),
  })),
});
