-- MW-based tier boxing: purchased business band's MW cap (Stripe price
-- metadata mw_cap). Additive only.

ALTER TABLE "Subscription" ADD COLUMN "mw_cap" DECIMAL(10,3);
