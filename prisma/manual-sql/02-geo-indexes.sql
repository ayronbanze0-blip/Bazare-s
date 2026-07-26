-- ─────────────────────────────────────────────────────────────────
-- Índice para a ordenação "perto de mim" (GET /products?sort=distance).
--
-- As colunas latitude/longitude do Bazar já vêm do schema.prisma (via
-- `npx prisma migrate dev` ou `db push` — corre isso primeiro). Este
-- índice parcial só acelera o filtro "bazar tem localização definida",
-- que é o primeiro passo do cálculo de distância em src/controllers/
-- productController.js. Não é crítico com poucas centenas/milhares de
-- bazares, mas ajuda a manter a consulta rápida à medida que cresce.
--
-- Como correr (Railway / psql):
--   psql "$DATABASE_URL" -f prisma/manual-sql/02-geo-indexes.sql
--
-- É seguro correr mais do que uma vez (IF NOT EXISTS). CONCURRENTLY
-- evita bloquear a tabela em produção.
-- ─────────────────────────────────────────────────────────────────

CREATE INDEX CONCURRENTLY IF NOT EXISTS bazar_geo_idx
  ON "Bazar" (latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
