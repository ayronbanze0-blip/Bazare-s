# Passar de `db push` para `migrate deploy` — passo obrigatório antes do próximo deploy

## O que mudou no Dockerfile

```diff
- CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node scripts/backfill-product-slugs.js && npm start"]
+ CMD ["sh", "-c", "npx prisma migrate deploy && (node scripts/backfill-product-slugs.js || true) && npm start"]
```

Duas coisas:
1. `db push --accept-data-loss` → `migrate deploy`. Deixa de aplicar o schema
   directamente (e de poder apagar dados silenciosamente em todo o arranque do
   container) — passa a aplicar apenas as migrations versionadas em
   `prisma/migrations/`, que ficam no histórico do git e revistas antes de existirem.
2. O backfill de slugs já não derruba o arranque da API se falhar (`|| true`) —
   antes, uma falha transitória nesse script impedia o `npm start` de sequer correr.

## ⚠️ Sem isto, o próximo deploy não faz NADA de schema

Este projecto **nunca usou `prisma migrate`** — não existe pasta `prisma/migrations/`.
`migrate deploy` com zero migrations não dá erro, mas também não cria/actualiza
nenhuma tabela. Como a tua base de dados já tem tudo (foi sempre criada via
`db push`), o próximo deploy corre bem na aparência — mas assim que criares a
PRIMEIRA migration a sério (ex.: adicionar uma coluna), o Prisma vai tentar criar
TODAS as tabelas do zero (porque não tem histórico nenhum) e vai falhar com
"relation already exists".

Por isso, antes de fazer deploy desta mudança, precisas de criar uma migration
de "baseline" que descreve o estado actual e marcá-la como já aplicada — **sem
tocar em nada da base de dados** (não corre nenhum SQL nela, só regista no
Prisma que "isto já está feito"). Não consegui correr isto por ti aqui (precisa
de rede para o Prisma CLI, e/ou de ligação à tua BD real) — corre estes 2
comandos no teu computador, uma única vez:

### 1. Gerar o SQL da baseline (não toca na BD, só lê o schema.prisma)

```bash
mkdir -p prisma/migrations/0_baseline
npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0_baseline/migration.sql
```

### 2. Marcar essa migration como já aplicada na BD de PRODUÇÃO

Isto não corre o SQL — só regista na tabela `_prisma_migrations` (criada
automaticamente) que essa migration já está feita, porque a tua BD já tem
tudo isso desde sempre.

```bash
DATABASE_URL="<a tua DATABASE_URL de produção>" npx prisma migrate resolve --applied 0_baseline
```

### 3. Commit + deploy

```bash
git add prisma/migrations Dockerfile
git commit -m "Passar de prisma db push para migrate deploy, com baseline"
git push
```

A partir daqui, qualquer mudança de schema segue o fluxo normal do Prisma:

```bash
npx prisma migrate dev --name descricao-curta-da-mudanca
git add prisma/migrations
git commit -m "..."
git push
```

O `migrate deploy` no Dockerfile aplica sozinho, no próximo deploy, só as
migrations novas que ainda não estão na BD — sem `--accept-data-loss`, sem
correr em todo o restart do container à toa.

## Se preferires adiar isto

Se não quiseres fazer o passo da baseline agora, reverte só a primeira linha
do CMD para `npx prisma db push --accept-data-loss` — mas mantém o `|| true`
no backfill, esse já é seguro e vale a pena manter de qualquer forma.
