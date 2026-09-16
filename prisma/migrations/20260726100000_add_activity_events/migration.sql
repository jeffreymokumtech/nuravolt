-- Product usage audit trail (founder-only /admin/usage). Applied out-of-band
-- via psql on local + prod (migrate dev is broken by an old shadow-DB
-- migration).

CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL,
    "org_clerk_id" TEXT NOT NULL,
    "user_id" TEXT,
    "user_label" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "plant_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ActivityEvent_org_clerk_id_created_at_idx" ON "ActivityEvent"("org_clerk_id", "created_at");
CREATE INDEX "ActivityEvent_action_created_at_idx" ON "ActivityEvent"("action", "created_at");
CREATE INDEX "ActivityEvent_created_at_idx" ON "ActivityEvent"("created_at");
