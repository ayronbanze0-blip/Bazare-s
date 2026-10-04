-- Wallet: fluxos completos (PIN, estorno, cancelamento, idempotência, pedidos de dinheiro).
-- Aditivo: não apaga nem altera dados existentes.

-- AlterEnum
ALTER TYPE "WalletTxType" ADD VALUE IF NOT EXISTS 'ESTORNO';
ALTER TYPE "WithdrawalStatus" ADD VALUE IF NOT EXISTS 'CANCELADO';

-- AlterTable: PIN da wallet
ALTER TABLE "Wallet"
  ADD COLUMN "pinHash" TEXT,
  ADD COLUMN "pinSetAt" TIMESTAMP(3),
  ADD COLUMN "pinFailedAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pinLockedUntil" TIMESTAMP(3);

-- AlterTable: idempotência (duplo clique / retry de rede)
ALTER TABLE "DepositRequest" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "WithdrawalRequest" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "DepositRequest_userId_idempotencyKey_key" ON "DepositRequest"("userId", "idempotencyKey");
CREATE UNIQUE INDEX "WithdrawalRequest_userId_idempotencyKey_key" ON "WithdrawalRequest"("userId", "idempotencyKey");

-- CreateEnum
CREATE TYPE "MoneyRequestStatus" AS ENUM ('PENDENTE', 'PAGO', 'RECUSADO', 'CANCELADO', 'EXPIRADO');

-- CreateTable
CREATE TABLE "MoneyRequest" (
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

-- CreateIndex
CREATE INDEX "MoneyRequest_requesterId_status_idx" ON "MoneyRequest"("requesterId", "status");
CREATE INDEX "MoneyRequest_payerId_status_idx" ON "MoneyRequest"("payerId", "status");

-- AddForeignKey
ALTER TABLE "MoneyRequest" ADD CONSTRAINT "MoneyRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MoneyRequest" ADD CONSTRAINT "MoneyRequest_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
