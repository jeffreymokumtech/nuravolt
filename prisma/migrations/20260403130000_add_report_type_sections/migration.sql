-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('portfolio', 'bess', 'combined');

-- AlterTable
ALTER TABLE "ScheduledReport" ADD COLUMN "report_type" "ReportType" NOT NULL DEFAULT 'portfolio';
ALTER TABLE "ScheduledReport" ADD COLUMN "report_sections" JSONB NOT NULL DEFAULT '[]';
