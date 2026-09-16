-- AlterEnum
ALTER TYPE "LLMInteractionType" ADD VALUE IF NOT EXISTS 'TICKET_NARRATION';

-- AlterTable: Ticket — add AI narration columns
ALTER TABLE "Ticket"
  ADD COLUMN "ai_narration" JSONB,
  ADD COLUMN "ai_model_used" TEXT,
  ADD COLUMN "ai_generated_at" TIMESTAMP(3),
  ADD COLUMN "ai_prompt_variant" TEXT,
  ADD COLUMN "ai_approved_by_clerk_id" TEXT,
  ADD COLUMN "ai_approved_at" TIMESTAMP(3),
  ADD COLUMN "ai_edited" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ai_edited_narration" JSONB,
  ADD COLUMN "ai_regeneration_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ai_interpretation_id" TEXT;

CREATE INDEX "Ticket_ai_prompt_variant_idx" ON "Ticket"("ai_prompt_variant");

-- AlterTable: LLMUsageSummary — add ticket narration token counter
ALTER TABLE "LLMUsageSummary"
  ADD COLUMN "ticket_narration_tokens" INTEGER NOT NULL DEFAULT 0;

-- CreateTable: TicketNarrationFeedback
CREATE TABLE "TicketNarrationFeedback" (
  "id" TEXT NOT NULL,
  "ticket_id" TEXT NOT NULL,
  "org_clerk_id" TEXT NOT NULL,
  "prompt_variant" TEXT NOT NULL,
  "field_changed" TEXT NOT NULL,
  "ai_value" TEXT NOT NULL,
  "human_value" TEXT NOT NULL,
  "resolution_time_h" DECIMAL(8,2),
  "resolution_correct" BOOLEAN,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TicketNarrationFeedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TicketNarrationFeedback_ticket_id_idx" ON "TicketNarrationFeedback"("ticket_id");
CREATE INDEX "TicketNarrationFeedback_prompt_variant_idx" ON "TicketNarrationFeedback"("prompt_variant");
CREATE INDEX "TicketNarrationFeedback_field_changed_idx" ON "TicketNarrationFeedback"("field_changed");
CREATE INDEX "TicketNarrationFeedback_org_clerk_id_idx" ON "TicketNarrationFeedback"("org_clerk_id");

ALTER TABLE "TicketNarrationFeedback"
  ADD CONSTRAINT "TicketNarrationFeedback_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "Ticket"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: NarrationVariantStats
CREATE TABLE "NarrationVariantStats" (
  "id" TEXT NOT NULL,
  "org_clerk_id" TEXT NOT NULL,
  "prompt_variant" TEXT NOT NULL,
  "period_start" DATE NOT NULL,
  "period_end" DATE NOT NULL,
  "tickets_narrated" INTEGER NOT NULL DEFAULT 0,
  "tickets_accepted_clean" INTEGER NOT NULL DEFAULT 0,
  "tickets_edited" INTEGER NOT NULL DEFAULT 0,
  "edits_summary" INTEGER NOT NULL DEFAULT 0,
  "edits_explanation" INTEGER NOT NULL DEFAULT 0,
  "edits_likely_cause" INTEGER NOT NULL DEFAULT 0,
  "edits_recommended" INTEGER NOT NULL DEFAULT 0,
  "edits_urgency" INTEGER NOT NULL DEFAULT 0,
  "edits_confidence" INTEGER NOT NULL DEFAULT 0,
  "urgency_correct_count" INTEGER NOT NULL DEFAULT 0,
  "urgency_total_labeled" INTEGER NOT NULL DEFAULT 0,
  "avg_resolution_time_h" DECIMAL(8,2),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NarrationVariantStats_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NarrationVariantStats_org_variant_period_key"
  ON "NarrationVariantStats"("org_clerk_id", "prompt_variant", "period_start", "period_end");
CREATE INDEX "NarrationVariantStats_prompt_variant_idx" ON "NarrationVariantStats"("prompt_variant");
CREATE INDEX "NarrationVariantStats_period_start_idx" ON "NarrationVariantStats"("period_start");

-- CreateTable: OrgLLMBudget
CREATE TABLE "OrgLLMBudget" (
  "org_clerk_id" TEXT NOT NULL,
  "daily_cap_usd" DECIMAL(8,2) NOT NULL DEFAULT 5.0,
  "monthly_cap_usd" DECIMAL(8,2) NOT NULL DEFAULT 100.0,
  "rate_limit_per_min" INTEGER NOT NULL DEFAULT 20,
  "alert_threshold_pct" INTEGER NOT NULL DEFAULT 80,
  "alert_email" TEXT,
  "alert_slack_webhook" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrgLLMBudget_pkey" PRIMARY KEY ("org_clerk_id")
);
