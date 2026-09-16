-- Add country (ISO 3166-1 alpha-2) and compliance pack binding to Plant
ALTER TABLE "Plant"
  ADD COLUMN "country" CHAR(2),
  ADD COLUMN "compliance_pack_version" TEXT;

CREATE INDEX "Plant_country_idx" ON "Plant"("country");

-- Backfill demo plants (Ribera + Alpha are in Spain)
UPDATE "Plant"
  SET "country" = 'ES',
      "compliance_pack_version" = '2026.Q2'
  WHERE slug IN ('ribera', 'alpha')
     OR LOWER(COALESCE(location_name, '')) LIKE '%spain%'
     OR LOWER(COALESCE(location_name, '')) LIKE '%españa%'
     OR LOWER(COALESCE(location_name, '')) LIKE '%espana%'
     OR LOWER(COALESCE(location_name, '')) LIKE '%catalonia%'
     OR LOWER(COALESCE(location_name, '')) LIKE '%region_a%'
     OR LOWER(COALESCE(location_name, '')) LIKE '%madrid%'
     OR LOWER(COALESCE(location_name, '')) LIKE '%barcelona%';
