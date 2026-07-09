-- ─────────────────────────────────────────────────────────────────
-- Índices de pesquisa (trigram) — para a pesquisa continuar rápida
-- com 500k+ produtos.
--
-- Porquê um script à parte e não no schema.prisma?
-- O Prisma consegue criar índices normais (B-tree) declarativamente,
-- mas os índices GIN/trigram do Postgres (extensão pg_trgm) exigem
-- SQL puro. Corre este script UMA VEZ, depois de aplicar as
-- migrações do schema.prisma (via `npm run db:migrate:deploy` ou
-- `npm run db:push`).
--
-- Como correr (Railway / psql):
--   psql "$DATABASE_URL" -f prisma/manual-sql/01-search-indexes.sql
--
-- Ou cola o conteúdo no separador "Query" do Railway/pgAdmin.
--
-- É seguro correr mais do que uma vez (tudo é IF NOT EXISTS).
-- CONCURRENTLY evita bloquear a tabela enquanto o índice é criado —
-- importante numa base de dados já em produção.
-- ─────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Pesquisa de produtos por nome/descrição (usada em GET /products?q=
-- e GET /search). Sem isto, uma pesquisa por "contains" faz uma
-- leitura sequencial da tabela inteira a partir de umas dezenas de
-- milhares de produtos.
CREATE INDEX CONCURRENTLY IF NOT EXISTS product_name_trgm_idx
  ON "Product" USING GIN (name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS product_description_trgm_idx
  ON "Product" USING GIN (description gin_trgm_ops);

-- Pesquisa de bazares por nome/descrição (GET /search).
CREATE INDEX CONCURRENTLY IF NOT EXISTS bazar_name_trgm_idx
  ON "Bazar" USING GIN (name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS bazar_description_trgm_idx
  ON "Bazar" USING GIN (description gin_trgm_ops);
