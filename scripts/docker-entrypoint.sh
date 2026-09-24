#!/bin/sh
# Arranque do contentor Bazares API.
#
# Regras de base de dados:
#   1. Existem migrations em prisma/migrations  -> `prisma migrate deploy` (o caminho normal;
#      só aplica migrations pendentes, NUNCA apaga dados nem "reconcilia" o schema à força).
#   2. NÃO existem migrations:
#        - em PRODUÇÃO falha com mensagem clara (não destrói nem altera o schema sozinho);
#        - fora de produção usa `prisma db push` (sem --accept-data-loss: recusa mudanças destrutivas).
#      Excepção explícita e temporária: ALLOW_DB_PUSH=true permite `db push` (também sem
#      --accept-data-loss) até a migration baseline ser criada. Ver docs/OPERACOES.md.
#
# `exec node` no fim: o Node passa a ser o processo principal (PID 1), por isso recebe o
# SIGTERM do Render/Docker e corre o encerramento gracioso (src/server.js). Antes, o `sh -c`
# e o `npm start` ficavam no meio e o sinal nunca chegava ao Node.
set -eu

echo "[entrypoint] NODE_ENV=${NODE_ENV:-development}"

if [ -d prisma/migrations ] && [ -n "$(ls -A prisma/migrations 2>/dev/null)" ]; then
  echo "[entrypoint] A aplicar migrations pendentes (prisma migrate deploy)..."
  npx prisma migrate deploy
elif [ "${ALLOW_DB_PUSH:-}" = "true" ]; then
  echo "[entrypoint] AVISO: sem prisma/migrations — a usar 'prisma db push' (SEM --accept-data-loss) por ALLOW_DB_PUSH=true."
  echo "[entrypoint] AVISO: crie a migration baseline e remova ALLOW_DB_PUSH (docs/OPERACOES.md)."
  npx prisma db push
elif [ "${NODE_ENV:-}" = "production" ]; then
  echo "[entrypoint] ERRO: prisma/migrations não existe (ou está vazio) e NODE_ENV=production." >&2
  echo "[entrypoint] Por segurança o schema NÃO é alterado automaticamente em produção." >&2
  echo "[entrypoint] Corra o workflow 'Prisma — criar migration baseline' e 'Prisma — marcar baseline como aplicada'" >&2
  echo "[entrypoint] (docs/OPERACOES.md), ou defina ALLOW_DB_PUSH=true temporariamente." >&2
  exit 1
else
  echo "[entrypoint] Desenvolvimento sem migrations — 'prisma db push'."
  npx prisma db push
fi

# Backfill idempotente (não bloqueia o arranque se falhar).
node scripts/backfill-product-slugs.js || echo "[entrypoint] backfill-product-slugs falhou (ignorado)."

exec node src/server.js
