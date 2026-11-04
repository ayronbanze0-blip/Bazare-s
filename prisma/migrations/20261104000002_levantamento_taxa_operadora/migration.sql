-- Taxa da operadora no levantamento (1,5%). Só adiciona uma coluna com DEFAULT.
ALTER TABLE "WithdrawalRequest" ADD COLUMN IF NOT EXISTS "operatorFee" DOUBLE PRECISION NOT NULL DEFAULT 0;
