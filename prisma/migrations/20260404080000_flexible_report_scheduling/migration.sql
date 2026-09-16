-- Add new ReportPeriod values
ALTER TYPE "ReportPeriod" ADD VALUE IF NOT EXISTS 'last_14d';
ALTER TYPE "ReportPeriod" ADD VALUE IF NOT EXISTS 'last_quarter';
ALTER TYPE "ReportPeriod" ADD VALUE IF NOT EXISTS 'year_to_date';
ALTER TYPE "ReportPeriod" ADD VALUE IF NOT EXISTS 'custom';

-- Add scheduling flexibility fields
ALTER TABLE "ScheduledReport" ADD COLUMN IF NOT EXISTS "send_day_of_week" INTEGER;
ALTER TABLE "ScheduledReport" ADD COLUMN IF NOT EXISTS "send_day_of_month" INTEGER;
ALTER TABLE "ScheduledReport" ADD COLUMN IF NOT EXISTS "send_time_utc" TEXT DEFAULT '07:00';
ALTER TABLE "ScheduledReport" ADD COLUMN IF NOT EXISTS "custom_start" TIMESTAMP(3);
ALTER TABLE "ScheduledReport" ADD COLUMN IF NOT EXISTS "custom_end" TIMESTAMP(3);
