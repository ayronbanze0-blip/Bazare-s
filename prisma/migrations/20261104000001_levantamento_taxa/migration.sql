-- Taxa da Bazares no levantamento (3%). Só adiciona uma coluna com DEFAULT.
ALTER TABLE "WithdrawalRequest" ADD COLUMN IF NOT EXISTS "fee" DOUBLE PRECISION NOT NULL DEFAULT 0;
