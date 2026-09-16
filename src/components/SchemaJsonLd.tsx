/**
 * SchemaJsonLd, renders one or many JSON-LD blocks into the page.
 *
 * Server component (no client JS). Pass a single schema object or an array;
 * each becomes its own <script type="application/ld+json">. Build the objects
 * with the buildXxxSchema() helpers in src/libs/seo.tsx.
 */
export default function SchemaJsonLd({
  data,
}: {
  data: Record<string, any> | Record<string, any>[];
}) {
  const blocks = Array.isArray(data) ? data : [data];
  return (
    <>
      {blocks.map((block, i) => (
        <script
          key={i}
          type="application/ld+json"
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: JSON.stringify(block) }}
        />
      ))}
    </>
  );
}
