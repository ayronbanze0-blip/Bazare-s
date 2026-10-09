-- Reparação idempotente (9 Out 2026).
-- Problema: em produção o job `commerceJobs:installments` falhava com
--   "The table `public.Installment` does not exist"
-- apesar de `prisma migrate deploy` dizer "No pending migrations": a migration
-- 20261006000000_fase5_app_completo ficou registada como aplicada sem criar tudo.
-- Esta migration volta a garantir, SEM apagar nem alterar dados, tudo o que as
-- migrations recentes deviam ter criado. Cada instrução é segura de repetir
-- (IF NOT EXISTS / bloco DO com duplicate_object), por isso é um no-op onde já existe.
-- Nota: a tabela "Save" (add-save-model) não está aqui de propósito — essa pasta
-- ordena-se DEPOIS desta e o seu CREATE TABLE simples falharia numa base nova.

-- ═══ A) Wallet / dinheiro (20261004000000_wallet_fluxos_completos, 20261006000001) ═══
ALTER TYPE "WalletTxType" ADD VALUE IF NOT EXISTS 'ESTORNO';
ALTER TYPE "WalletTxType" ADD VALUE IF NOT EXISTS 'PAGAMENTO_COMPRA';
ALTER TYPE "WalletTxType" ADD VALUE IF NOT EXISTS 'RECEBIMENTO_VENDA';
ALTER TYPE "WalletTxType" ADD VALUE IF NOT EXISTS 'REEMBOLSO_COMPRA';
ALTER TYPE "WalletTxType" ADD VALUE IF NOT EXISTS 'REEMBOLSO_VENDA';
ALTER TYPE "WithdrawalStatus" ADD VALUE IF NOT EXISTS 'CANCELADO';

ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "pinHash" TEXT;
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "pinSetAt" TIMESTAMP(3);
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "pinFailedAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "pinLockedUntil" TIMESTAMP(3);

ALTER TABLE "DepositRequest" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE "WithdrawalRequest" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "DepositRequest_userId_idempotencyKey_key" ON "DepositRequest"("userId", "idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "WithdrawalRequest_userId_idempotencyKey_key" ON "WithdrawalRequest"("userId", "idempotencyKey");

DO $$ BEGIN CREATE TYPE "MoneyRequestStatus" AS ENUM ('PENDENTE', 'PAGO', 'RECUSADO', 'CANCELADO', 'EXPIRADO'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS "MoneyRequest" (
  "id" TEXT NOT NULL,
  "requesterId" TEXT NOT NULL,
  "payerId" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "note" TEXT,
  "status" "MoneyRequestStatus" NOT NULL DEFAULT 'PENDENTE',
  "respondedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MoneyRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "MoneyRequest_requesterId_status_idx" ON "MoneyRequest"("requesterId", "status");
CREATE INDEX IF NOT EXISTS "MoneyRequest_payerId_status_idx" ON "MoneyRequest"("payerId", "status");
DO $$ BEGIN
  ALTER TABLE "MoneyRequest" ADD CONSTRAINT "MoneyRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "MoneyRequest" ADD CONSTRAINT "MoneyRequest_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ═══ B) Denúncias universais (20261005000000) ═══
ALTER TYPE "ReportType" ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT';
ALTER TYPE "ReportType" ADD VALUE IF NOT EXISTS 'REEL';
ALTER TYPE "ReportType" ADD VALUE IF NOT EXISTS 'STORY';
ALTER TYPE "ReportType" ADD VALUE IF NOT EXISTS 'COMMENT';
ALTER TYPE "ReportType" ADD VALUE IF NOT EXISTS 'GROUP_POST';
ALTER TYPE "ReportType" ADD VALUE IF NOT EXISTS 'COMMUNITY';
ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "targetId" TEXT;
CREATE INDEX IF NOT EXISTS "Report_type_targetId_idx" ON "Report"("type", "targetId");

-- ═══ C) Evolução do schema v2 (1_evolucao_schema_v2) ═══
CREATE TABLE IF NOT EXISTS "PaymentWebhookEvent" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "type" TEXT,
  "reference" TEXT,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "error" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "ProductStat" (
  "productId" TEXT NOT NULL,
  "cartAdds" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductStat_pkey" PRIMARY KEY ("productId")
);
CREATE TABLE IF NOT EXISTS "NotificationPreference" (
  "userId" TEXT NOT NULL,
  "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
  "pushEnabled" BOOLEAN NOT NULL DEFAULT true,
  "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
  "orderNotifications" BOOLEAN NOT NULL DEFAULT true,
  "messageNotifications" BOOLEAN NOT NULL DEFAULT true,
  "socialNotifications" BOOLEAN NOT NULL DEFAULT true,
  "marketingNotifications" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);
CREATE INDEX IF NOT EXISTS "PaymentWebhookEvent_reference_idx" ON "PaymentWebhookEvent"("reference");
CREATE INDEX IF NOT EXISTS "PaymentWebhookEvent_status_receivedAt_idx" ON "PaymentWebhookEvent"("status", "receivedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentWebhookEvent_provider_eventKey_key" ON "PaymentWebhookEvent"("provider", "eventKey");
DO $$ BEGIN
  ALTER TABLE "ProductStat" ADD CONSTRAINT "ProductStat_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ═══ D) Fase 5 — cupões, entrega, moradas, PARCELAS, disputas, suporte, banners, visualizações ═══
-- (cópia exacta de 20261006000000_fase5_app_completo, que já é toda idempotente)
-- Fase 5 — App completo: descontos, entrega, parcelas, disputas, suporte, banners, visualizações.
-- Idempotente onde possível (IF NOT EXISTS) para poder ser re-executada com segurança.

-- ─── Enums ──────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "CouponType" AS ENUM ('PERCENT', 'FIXED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CouponRedemptionStatus" AS ENUM ('APPLIED', 'REVERTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "InstallmentPlanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'DEFAULTED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "InstallmentStatus" AS ENUM ('PENDENTE', 'PAGA', 'ATRASADA', 'CANCELADA'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'SELLER_RESPONDED', 'RESOLVED_REFUND', 'RESOLVED_REJECTED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'PENDING_USER', 'RESOLVED', 'CLOSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ViewTargetType" AS ENUM ('PRODUCT', 'BAZAR', 'REEL', 'POST', 'PROFILE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Colunas novas em tabelas existentes (todas com default → sem reescrever dados) ───
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "couponCode" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "shippingFee" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "shippingZone" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "paymentMode" TEXT NOT NULL DEFAULT 'ENTREGA';
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "originalPrice" DOUBLE PRECISION;
ALTER TABLE "Review" ADD COLUMN IF NOT EXISTS "sellerReply" TEXT;
ALTER TABLE "Review" ADD COLUMN IF NOT EXISTS "sellerRepliedAt" TIMESTAMP(3);

-- ─── Cupões ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Coupon" (
  "id" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "description" TEXT,
  "type" "CouponType" NOT NULL,
  "value" DOUBLE PRECISION NOT NULL,
  "minOrderAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "maxDiscount" DOUBLE PRECISION,
  "usageLimit" INTEGER,
  "perUserLimit" INTEGER NOT NULL DEFAULT 1,
  "usedCount" INTEGER NOT NULL DEFAULT 0,
  "firstOrderOnly" BOOLEAN NOT NULL DEFAULT false,
  "productIds" TEXT[],
  "startsAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Coupon_code_key" ON "Coupon"("code");
CREATE INDEX IF NOT EXISTS "Coupon_sellerId_active_idx" ON "Coupon"("sellerId", "active");

CREATE TABLE IF NOT EXISTS "CouponRedemption" (
  "id" TEXT NOT NULL,
  "couponId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "status" "CouponRedemptionStatus" NOT NULL DEFAULT 'APPLIED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revertedAt" TIMESTAMP(3),
  CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CouponRedemption_couponId_orderId_key" ON "CouponRedemption"("couponId", "orderId");
CREATE INDEX IF NOT EXISTS "CouponRedemption_couponId_userId_status_idx" ON "CouponRedemption"("couponId", "userId", "status");
CREATE INDEX IF NOT EXISTS "CouponRedemption_orderId_idx" ON "CouponRedemption"("orderId");

-- ─── Promoções de produto ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ProductPromotion" (
  "productId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "salePrice" DOUBLE PRECISION NOT NULL,
  "originalPrice" DOUBLE PRECISION NOT NULL,
  "label" TEXT,
  "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductPromotion_pkey" PRIMARY KEY ("productId")
);
CREATE INDEX IF NOT EXISTS "ProductPromotion_active_endsAt_idx" ON "ProductPromotion"("active", "endsAt");
CREATE INDEX IF NOT EXISTS "ProductPromotion_sellerId_idx" ON "ProductPromotion"("sellerId");

-- ─── Entrega e moradas ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "DeliveryZone" (
  "id" TEXT NOT NULL,
  "bazarId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "freeAbove" DOUBLE PRECISION,
  "etaDays" INTEGER,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeliveryZone_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "DeliveryZone_bazarId_active_idx" ON "DeliveryZone"("bazarId", "active");

CREATE TABLE IF NOT EXISTS "Address" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "recipientName" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "line" TEXT NOT NULL,
  "city" TEXT,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "notes" TEXT,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Address_userId_isDefault_idx" ON "Address"("userId", "isDefault");

CREATE TABLE IF NOT EXISTS "OrderStatusHistory" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "status" "OrderStatus" NOT NULL,
  "actorId" TEXT,
  "actorRole" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderStatusHistory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "OrderStatusHistory_orderId_createdAt_idx" ON "OrderStatusHistory"("orderId", "createdAt");

-- Encomendas já existentes ganham uma linha inicial no histórico (o estado em que estão agora)
INSERT INTO "OrderStatusHistory" ("id", "orderId", "status", "actorRole", "note", "createdAt")
SELECT gen_random_uuid()::text, o."id", o."status", 'system', 'Estado à data da migração', o."updatedAt"
FROM "Order" o
WHERE NOT EXISTS (SELECT 1 FROM "OrderStatusHistory" h WHERE h."orderId" = o."id");

-- ─── Carteira / parcelas ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "InstallmentSetting" (
  "sellerId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "maxInstallments" INTEGER NOT NULL DEFAULT 3,
  "minOrderAmount" DOUBLE PRECISION NOT NULL DEFAULT 500,
  "downPaymentPct" DOUBLE PRECISION NOT NULL DEFAULT 30,
  "interestPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "frequencyDays" INTEGER NOT NULL DEFAULT 30,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InstallmentSetting_pkey" PRIMARY KEY ("sellerId")
);

CREATE TABLE IF NOT EXISTS "InstallmentPlan" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "buyerId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "count" INTEGER NOT NULL,
  "frequencyDays" INTEGER NOT NULL DEFAULT 30,
  "interestPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "principal" DOUBLE PRECISION NOT NULL,
  "totalAmount" DOUBLE PRECISION NOT NULL,
  "paidAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "refundedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "refundPendingAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "autoPay" BOOLEAN NOT NULL DEFAULT true,
  "status" "InstallmentPlanStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InstallmentPlan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "InstallmentPlan_orderId_key" ON "InstallmentPlan"("orderId");
CREATE INDEX IF NOT EXISTS "InstallmentPlan_buyerId_status_idx" ON "InstallmentPlan"("buyerId", "status");
CREATE INDEX IF NOT EXISTS "InstallmentPlan_sellerId_status_idx" ON "InstallmentPlan"("sellerId", "status");

CREATE TABLE IF NOT EXISTS "Installment" (
  "id" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "dueDate" TIMESTAMP(3) NOT NULL,
  "status" "InstallmentStatus" NOT NULL DEFAULT 'PENDENTE',
  "lateFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "paidAt" TIMESTAMP(3),
  "reminderSentAt" TIMESTAMP(3),
  "overdueNotifiedAt" TIMESTAMP(3),
  "lastAutoPayAttemptAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Installment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Installment_planId_number_key" ON "Installment"("planId", "number");
CREATE INDEX IF NOT EXISTS "Installment_status_dueDate_idx" ON "Installment"("status", "dueDate");

-- ─── Disputas ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "OrderDispute" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "buyerId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "evidenceUrls" TEXT[],
  "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
  "sellerResponse" TEXT,
  "respondedAt" TIMESTAMP(3),
  "resolution" TEXT,
  "refundAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "restock" BOOLEAN NOT NULL DEFAULT false,
  "resolvedById" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderDispute_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "OrderDispute_orderId_key" ON "OrderDispute"("orderId");
CREATE INDEX IF NOT EXISTS "OrderDispute_status_createdAt_idx" ON "OrderDispute"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "OrderDispute_buyerId_idx" ON "OrderDispute"("buyerId");
CREATE INDEX IF NOT EXISTS "OrderDispute_sellerId_idx" ON "OrderDispute"("sellerId");

-- ─── Suporte ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "SupportTicket" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "orderId" TEXT,
  "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SupportTicket_userId_status_idx" ON "SupportTicket"("userId", "status");
CREATE INDEX IF NOT EXISTS "SupportTicket_status_lastMessageAt_idx" ON "SupportTicket"("status", "lastMessageAt");

CREATE TABLE IF NOT EXISTS "SupportMessage" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "isStaff" BOOLEAN NOT NULL DEFAULT false,
  "body" TEXT NOT NULL,
  "attachments" TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SupportMessage_ticketId_createdAt_idx" ON "SupportMessage"("ticketId", "createdAt");

-- ─── Banners ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Banner" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "subtitle" TEXT,
  "imageUrl" TEXT NOT NULL,
  "linkType" TEXT NOT NULL DEFAULT 'NONE',
  "linkValue" TEXT,
  "placement" TEXT NOT NULL DEFAULT 'HOME_TOP',
  "audience" TEXT NOT NULL DEFAULT 'ALL',
  "position" INTEGER NOT NULL DEFAULT 0,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Banner_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Banner_placement_active_position_idx" ON "Banner"("placement", "active", "position");

-- ─── Visualizações ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ViewDaily" (
  "targetType" "ViewTargetType" NOT NULL,
  "targetId" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "views" INTEGER NOT NULL DEFAULT 0,
  "uniques" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ViewDaily_pkey" PRIMARY KEY ("targetType", "targetId", "day")
);
CREATE INDEX IF NOT EXISTS "ViewDaily_targetId_day_idx" ON "ViewDaily"("targetId", "day");
CREATE INDEX IF NOT EXISTS "ViewDaily_day_idx" ON "ViewDaily"("day");

CREATE TABLE IF NOT EXISTS "ViewVisitor" (
  "targetType" "ViewTargetType" NOT NULL,
  "targetId" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "visitorKey" TEXT NOT NULL,
  CONSTRAINT "ViewVisitor_pkey" PRIMARY KEY ("targetType", "targetId", "day", "visitorKey")
);
CREATE INDEX IF NOT EXISTS "ViewVisitor_day_idx" ON "ViewVisitor"("day");

CREATE TABLE IF NOT EXISTS "ViewHistory" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "viewCount" INTEGER NOT NULL DEFAULT 1,
  "lastViewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ViewHistory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ViewHistory_userId_productId_key" ON "ViewHistory"("userId", "productId");
CREATE INDEX IF NOT EXISTS "ViewHistory_userId_lastViewedAt_idx" ON "ViewHistory"("userId", "lastViewedAt");

-- ─── Chaves estrangeiras (adicionadas só se ainda não existirem) ─────
DO $$ BEGIN
  ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProductPromotion" ADD CONSTRAINT "ProductPromotion_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DeliveryZone" ADD CONSTRAINT "DeliveryZone_bazarId_fkey" FOREIGN KEY ("bazarId") REFERENCES "Bazar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Address" ADD CONSTRAINT "Address_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "InstallmentSetting" ADD CONSTRAINT "InstallmentSetting_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "InstallmentPlan" ADD CONSTRAINT "InstallmentPlan_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "InstallmentPlan" ADD CONSTRAINT "InstallmentPlan_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "InstallmentPlan" ADD CONSTRAINT "InstallmentPlan_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Installment" ADD CONSTRAINT "Installment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "InstallmentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "OrderDispute" ADD CONSTRAINT "OrderDispute_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "OrderDispute" ADD CONSTRAINT "OrderDispute_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "OrderDispute" ADD CONSTRAINT "OrderDispute_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ViewHistory" ADD CONSTRAINT "ViewHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ViewHistory" ADD CONSTRAINT "ViewHistory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
