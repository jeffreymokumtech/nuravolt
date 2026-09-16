-- CreateEnum
CREATE TYPE "ReportSchedule" AS ENUM ('weekly', 'monthly');

-- CreateEnum
CREATE TYPE "ReportPeriod" AS ENUM ('last_7d', 'last_30d', 'last_month');

-- CreateTable
CREATE TABLE "ScheduledReport" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schedule" "ReportSchedule" NOT NULL,
    "period" "ReportPeriod" NOT NULL,
    "recipient_emails" TEXT[],
    "plant_ids" TEXT[],
    "include_summary" BOOLEAN NOT NULL DEFAULT true,
    "include_risk" BOOLEAN NOT NULL DEFAULT true,
    "include_losses" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_sent_at" TIMESTAMP(3),
    "next_run_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledReport_is_active_next_run_at_idx" ON "ScheduledReport"("is_active", "next_run_at");
