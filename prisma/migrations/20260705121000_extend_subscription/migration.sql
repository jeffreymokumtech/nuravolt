-- Extend Subscription for org-keyed Stripe billing (Phase C).
-- Additive only; existing rows default to plan 'residential'.

ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'trialing';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'past_due';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'canceled';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'unpaid';

ALTER TABLE "Subscription"
    ADD COLUMN "org_id" TEXT,
    ADD COLUMN "plan_id" TEXT NOT NULL DEFAULT 'residential',
    ADD COLUMN "stripe_price_id" TEXT,
    ADD COLUMN "current_period_end" TIMESTAMP(3),
    ADD COLUMN "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX "Subscription_org_id_key" ON "Subscription"("org_id");
