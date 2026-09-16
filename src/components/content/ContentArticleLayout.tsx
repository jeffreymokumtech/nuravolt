import PublicLayout from '@/components/layouts/PublicLayout';
import SchemaJsonLd from '@/components/SchemaJsonLd';
import Breadcrumbs from '@/components/content/Breadcrumbs';
import QuickAnswer from '@/components/content/QuickAnswer';
import RelatedLinks from '@/components/content/RelatedLinks';
import FaqAccordion from '@/components/content/FaqAccordion';
import ContentCta from '@/components/content/ContentCta';
import LeadCaptureForm from '@/components/resources/LeadCaptureForm';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  buildArticleSchema,
  buildBreadcrumbSchema,
  buildFAQSchema,
} from '@/libs/seo';
import type { ArticleView, ContentBlock, ContentSection } from '@/data/content/types';

/**
 * ContentArticleLayout, the single rendering path for every catalog template
 * (faults, BESS metrics, integrations, insights). Takes a normalized
 * ArticleView, renders the page, and emits TechArticle + FAQPage +
 * BreadcrumbList JSON-LD.
 */
export default function ContentArticleLayout({ article }: { article: ArticleView }) {
  const crumbs = [
    { name: 'Home', urlRelative: '/' },
    { name: article.hub.label, urlRelative: article.hub.href },
    { name: article.title, urlRelative: article.urlRelative },
  ];

  const schema: Record<string, any>[] = [
    buildArticleSchema({
      title: article.title,
      description: article.quickAnswer,
      urlRelative: article.urlRelative,
      datePublished: article.datePublished,
      image: article.heroImage,
    }),
    buildBreadcrumbSchema(crumbs),
  ];
  if (article.faq.length) schema.push(buildFAQSchema(article.faq));
  if (article.schemaExtras?.length) schema.push(...article.schemaExtras);

  return (
    <PublicLayout>
      <SchemaJsonLd data={schema} />
      <article className="container mx-auto px-4 sm:px-6 lg:px-8 py-10 max-w-3xl">
        <Breadcrumbs items={crumbs.map((c) => ({ name: c.name, href: c.urlRelative }))} />

        <p className="font-mono text-meta uppercase tracking-[0.08em] text-primary mb-2">
          {article.category}
        </p>
        <h1 className="text-3xl sm:text-4xl font-bold text-ink tracking-tight">
          {article.title}
        </h1>
        {article.intro && <p className="mt-3 text-lg text-ink-2">{article.intro}</p>}

        <QuickAnswer>{article.quickAnswer}</QuickAnswer>

        <div className="mt-8 space-y-8">
          {article.sections.map((section) => (
            <Section key={section.heading} section={section} />
          ))}
        </div>

        {article.sources && article.sources.length > 0 && (
          <p className="mt-10 text-meta text-ink-3">
            <span className="font-medium text-ink-2">Methodology &amp; sources:</span>{' '}
            {article.sources.join(' · ')}
          </p>
        )}

        {article.dataset && (
          <section className="mt-12 rounded-xl border border-divider bg-paper-2 p-7">
            <h2 className="text-xl font-semibold text-ink">Get the raw dataset</h2>
            <p className="mt-2 max-w-xl text-sm text-ink-2">{article.dataset.blurb}</p>
            <div className="mt-5 max-w-md">
              <LeadCaptureForm
                resourceSlug={article.dataset.slug}
                resourceType="dataset"
                resourceTitle={article.dataset.title}
                downloadUrl={article.dataset.downloadUrl}
              />
            </div>
          </section>
        )}

        <FaqAccordion faqs={article.faq} />
        <RelatedLinks links={article.related} />
        <ContentCta />
      </article>
    </PublicLayout>
  );
}

function Section({ section }: { section: ContentSection }) {
  return (
    <section>
      <h2 className="text-xl font-semibold text-ink mb-3">{section.heading}</h2>
      <div className="space-y-3">
        {section.blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}
      </div>
    </section>
  );
}

function Block({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case 'paragraph':
      return <p className="text-ink-2 leading-relaxed">{block.text}</p>;
    case 'list':
      return (
        <ul className="list-disc space-y-1.5 pl-5 text-ink-2 leading-relaxed marker:text-primary">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case 'keyValue':
      return (
        <dl className="divide-y divide-divider rounded-lg border border-divider">
          {block.pairs.map((pair, i) => (
            <div key={i} className="grid grid-cols-[auto_1fr] gap-4 px-4 py-2.5">
              <dt className="font-mono text-sm font-medium text-primary">{pair.label}</dt>
              <dd className="text-sm text-ink-2">{pair.value}</dd>
            </div>
          ))}
        </dl>
      );
    case 'code':
      return (
        <pre className="overflow-x-auto rounded-lg border border-divider bg-paper-2 px-4 py-3 font-mono text-sm text-ink">
          {block.text}
        </pre>
      );
    case 'table':
      return (
        <div className="overflow-x-auto rounded-lg border border-divider">
          <Table>
            {block.caption && <TableCaption>{block.caption}</TableCaption>}
            <TableHeader>
              <TableRow>
                {block.headers.map((h, i) => (
                  <TableHead key={i} className="text-ink-2">{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {block.rows.map((row, ri) => (
                <TableRow key={ri}>
                  {row.map((cell, ci) => (
                    <TableCell
                      key={ci}
                      className={ci === 0 ? 'font-medium text-ink' : 'text-ink-2'}
                    >
                      {cell}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      );
    case 'stat':
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          {block.items.map((it, i) => (
            <div key={i} className="rounded-lg border border-divider bg-paper-2 p-4">
              <div className="text-2xl font-bold tracking-tight text-ink">{it.value}</div>
              <div className="mt-1 text-sm font-medium text-ink-2">{it.label}</div>
              {it.sub && <div className="mt-0.5 text-meta text-ink-3">{it.sub}</div>}
            </div>
          ))}
        </div>
      );
    default:
      return null;
  }
}
