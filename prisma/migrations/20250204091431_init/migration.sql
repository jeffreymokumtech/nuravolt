-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'inactive');

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "user_email" TEXT NOT NULL,
    "sub_status" "SubscriptionStatus" NOT NULL DEFAULT 'inactive',
    "sub_type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "last_stripe_cs_id" TEXT NOT NULL,
    "stripe_customer_id" TEXT NOT NULL,
    "sub_stripe_id" TEXT,
    "user_clerk_id" TEXT NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "connection_id" INTEGER NOT NULL,
    "webhook_id" INTEGER NOT NULL,
    "scenario_id" INTEGER NOT NULL,
    "user_clerk_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Audiences" (
    "id" TEXT NOT NULL,
    "resend_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Audiences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_user_email_key" ON "Subscription"("user_email");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_last_stripe_cs_id_key" ON "Subscription"("last_stripe_cs_id");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_stripe_customer_id_key" ON "Subscription"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_user_clerk_id_key" ON "Subscription"("user_clerk_id");

-- CreateIndex
CREATE UNIQUE INDEX "Audiences_resend_id_key" ON "Audiences"("resend_id");
