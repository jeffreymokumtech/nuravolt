-- Outbound integrations: signed webhooks on ticket lifecycle events (arc 9).
-- Applied out-of-band via psql on local + prod (migrate dev is broken by an
-- old shadow-DB migration).

CREATE TABLE "IntegrationWebhook" (
    "id" TEXT NOT NULL,
    "org_clerk_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationWebhook_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "response_code" INTEGER,
    "error" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IntegrationWebhook_org_clerk_id_active_idx" ON "IntegrationWebhook"("org_clerk_id", "active");
CREATE INDEX "WebhookDelivery_webhook_id_created_at_idx" ON "WebhookDelivery"("webhook_id", "created_at");

ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "IntegrationWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
