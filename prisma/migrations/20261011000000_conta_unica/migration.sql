-- CONTA ÚNICA: toda a gente compra e vende, sem passo de "tornar-se vendedor".
-- 1) Novas contas passam a nascer como SELLER (conta completa).
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'SELLER';

-- 2) Contas existentes que ainda eram BUYER passam a SELLER.
--    Não toca em ADMIN nem em REVENDEDOR.
UPDATE "User" SET "role" = 'SELLER' WHERE "role" = 'BUYER';
