-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "closedKind" TEXT,
ADD COLUMN     "codeAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "codeLockedUntil" TIMESTAMP(3),
ADD COLUMN     "codeNonce" TEXT,
ADD COLUMN     "deliveryDeadline" TIMESTAMP(3),
ADD COLUMN     "escrowAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "escrowState" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "payDeadline" TIMESTAMP(3),
ADD COLUMN     "payIdempotencyKey" TEXT,
ADD COLUMN     "releasedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OrderDispute" ADD COLUMN     "openedById" TEXT;

-- AlterTable
ALTER TABLE "WithdrawalRequest" ADD COLUMN     "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "operatorFee" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Order_escrowState_idx" ON "Order"("escrowState");

