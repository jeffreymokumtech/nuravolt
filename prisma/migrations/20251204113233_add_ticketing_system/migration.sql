-- CreateEnum
CREATE TYPE "public"."TicketStatus" AS ENUM ('NEW', 'VALIDATED', 'ASSIGNED', 'IN_PROGRESS', 'DONE', 'WONT_FIX');

-- CreateEnum
CREATE TYPE "public"."TicketPriority" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "public"."TicketTriggerType" AS ENUM ('SOILING_FORECAST', 'PERFORMANCE_ANOMALY', 'THRESHOLD_ALERT', 'SCHEDULED_MAINTENANCE', 'MANUAL_CREATION');

-- CreateEnum
CREATE TYPE "public"."TicketValidationAction" AS ENUM ('VALIDATED_CORRECT', 'VALIDATED_ADJUSTED', 'DISMISSED_FALSE_POSITIVE', 'DISMISSED_DUPLICATE', 'DISMISSED_NOT_ACTIONABLE');

-- CreateTable
CREATE TABLE "public"."SoilingForecast" (
    "id" TEXT NOT NULL,
    "plant_id" TEXT NOT NULL,
    "inverter_id" TEXT,
    "forecast_date" TIMESTAMP(3) NOT NULL,
    "forecast_created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "soiling_ratio_predicted" DECIMAL(6,5) NOT NULL,
    "soiling_ratio_lower_bound" DECIMAL(6,5) NOT NULL,
    "soiling_ratio_upper_bound" DECIMAL(6,5) NOT NULL,
    "soiling_loss_pct" DECIMAL(5,2) NOT NULL,
    "model_type" TEXT NOT NULL,
    "physics_component" DECIMAL(6,5),
    "ml_component" DECIMAL(6,5),
    "confidence_score" DECIMAL(3,2),
    "is_cleaning_needed" BOOLEAN NOT NULL DEFAULT false,
    "cleaning_priority" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SoilingForecast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SoilingEvent" (
    "id" TEXT NOT NULL,
    "plant_id" TEXT NOT NULL,
    "inverter_id" TEXT,
    "event_date" TIMESTAMP(3) NOT NULL,
    "event_type" TEXT NOT NULL,
    "pre_event_sr" DECIMAL(6,5),
    "post_event_sr" DECIMAL(6,5),
    "recovery_pct" DECIMAL(5,2),
    "detection_method" TEXT NOT NULL,
    "confidence" DECIMAL(3,2),
    "energy_recovered_kwh" DECIMAL(10,2),
    "revenue_impact_eur" DECIMAL(10,2),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SoilingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CleaningSchedule" (
    "id" TEXT NOT NULL,
    "plant_id" TEXT NOT NULL,
    "schedule_name" TEXT NOT NULL,
    "recommended_dates" JSONB NOT NULL,
    "n_cleanings" INTEGER NOT NULL,
    "energy_recovered_mwh" DECIMAL(10,2) NOT NULL,
    "revenue_recovered_eur" DECIMAL(10,2) NOT NULL,
    "cleaning_cost_eur" DECIMAL(10,2) NOT NULL,
    "net_benefit_eur" DECIMAL(10,2) NOT NULL,
    "roi_pct" DECIMAL(6,2) NOT NULL,
    "payback_days" DECIMAL(5,1) NOT NULL,
    "avg_sr_baseline" DECIMAL(6,5) NOT NULL,
    "avg_sr_optimized" DECIMAL(6,5) NOT NULL,
    "is_optimal" BOOLEAN NOT NULL DEFAULT false,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CleaningSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ModelPerformance" (
    "id" TEXT NOT NULL,
    "plant_id" TEXT NOT NULL,
    "inverter_id" TEXT,
    "model_type" TEXT NOT NULL,
    "model_version" TEXT NOT NULL,
    "evaluation_start" TIMESTAMP(3) NOT NULL,
    "evaluation_end" TIMESTAMP(3) NOT NULL,
    "n_samples" INTEGER NOT NULL,
    "mae" DECIMAL(8,6) NOT NULL,
    "rmse" DECIMAL(8,6) NOT NULL,
    "r2_score" DECIMAL(5,4) NOT NULL,
    "mean_bias" DECIMAL(8,6) NOT NULL,
    "precision" DECIMAL(5,4),
    "recall" DECIMAL(5,4),
    "f1_score" DECIMAL(5,4),
    "backtest_type" TEXT NOT NULL,
    "forecast_horizon" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelPerformance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Ticket" (
    "id" TEXT NOT NULL,
    "org_clerk_id" TEXT NOT NULL,
    "plant_id" TEXT NOT NULL,
    "inverter_id" TEXT,
    "status" "public"."TicketStatus" NOT NULL DEFAULT 'NEW',
    "priority" "public"."TicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "trigger_type" "public"."TicketTriggerType" NOT NULL,
    "trigger_id" TEXT,
    "trigger_metadata" JSONB,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assigned_to_clerk_id" TEXT,
    "assigned_at" TIMESTAMP(3),
    "assigned_by_clerk_id" TEXT,
    "validated_at" TIMESTAMP(3),
    "validated_by_clerk_id" TEXT,
    "validation_action" "public"."TicketValidationAction",
    "validation_notes" TEXT,
    "estimated_revenue_impact_eur" DECIMAL(10,2),
    "estimated_energy_loss_kwh" DECIMAL(10,2),
    "resolution_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TicketComment" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "author_clerk_id" TEXT NOT NULL,
    "org_clerk_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TicketHistory" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "old_status" "public"."TicketStatus",
    "new_status" "public"."TicketStatus" NOT NULL,
    "old_priority" "public"."TicketPriority",
    "new_priority" "public"."TicketPriority",
    "changed_by_clerk_id" TEXT NOT NULL,
    "change_reason" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SoilingForecast_plant_id_forecast_date_idx" ON "public"."SoilingForecast"("plant_id", "forecast_date");

-- CreateIndex
CREATE INDEX "SoilingForecast_inverter_id_forecast_date_idx" ON "public"."SoilingForecast"("inverter_id", "forecast_date");

-- CreateIndex
CREATE INDEX "SoilingForecast_forecast_created_at_idx" ON "public"."SoilingForecast"("forecast_created_at");

-- CreateIndex
CREATE UNIQUE INDEX "SoilingForecast_plant_id_inverter_id_forecast_date_forecast_key" ON "public"."SoilingForecast"("plant_id", "inverter_id", "forecast_date", "forecast_created_at");

-- CreateIndex
CREATE INDEX "SoilingEvent_plant_id_event_date_idx" ON "public"."SoilingEvent"("plant_id", "event_date");

-- CreateIndex
CREATE INDEX "SoilingEvent_event_type_idx" ON "public"."SoilingEvent"("event_type");

-- CreateIndex
CREATE INDEX "CleaningSchedule_plant_id_valid_from_idx" ON "public"."CleaningSchedule"("plant_id", "valid_from");

-- CreateIndex
CREATE INDEX "ModelPerformance_plant_id_model_type_idx" ON "public"."ModelPerformance"("plant_id", "model_type");

-- CreateIndex
CREATE INDEX "Ticket_org_clerk_id_idx" ON "public"."Ticket"("org_clerk_id");

-- CreateIndex
CREATE INDEX "Ticket_plant_id_idx" ON "public"."Ticket"("plant_id");

-- CreateIndex
CREATE INDEX "Ticket_status_idx" ON "public"."Ticket"("status");

-- CreateIndex
CREATE INDEX "Ticket_priority_idx" ON "public"."Ticket"("priority");

-- CreateIndex
CREATE INDEX "Ticket_trigger_type_idx" ON "public"."Ticket"("trigger_type");

-- CreateIndex
CREATE INDEX "Ticket_assigned_to_clerk_id_idx" ON "public"."Ticket"("assigned_to_clerk_id");

-- CreateIndex
CREATE INDEX "Ticket_created_at_idx" ON "public"."Ticket"("created_at");

-- CreateIndex
CREATE INDEX "TicketComment_ticket_id_idx" ON "public"."TicketComment"("ticket_id");

-- CreateIndex
CREATE INDEX "TicketComment_created_at_idx" ON "public"."TicketComment"("created_at");

-- CreateIndex
CREATE INDEX "TicketHistory_ticket_id_idx" ON "public"."TicketHistory"("ticket_id");

-- CreateIndex
CREATE INDEX "TicketHistory_changed_at_idx" ON "public"."TicketHistory"("changed_at");

-- AddForeignKey
ALTER TABLE "public"."Ticket" ADD CONSTRAINT "Ticket_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "public"."DiscoveredPlant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TicketComment" ADD CONSTRAINT "TicketComment_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TicketHistory" ADD CONSTRAINT "TicketHistory_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
