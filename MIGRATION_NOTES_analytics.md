# Analytics — como aplicar

1. `git pull` / copiar estes ficheiros para o repo real.
2. Actualizar a base de dados com o novo modelo `AnalyticsEvent`:
   ```
   npx prisma migrate dev --name add_analytics_event
   ```
   (em produção/Railway: `npx prisma migrate deploy`, ou `npx prisma db push` se seguires esse fluxo)
3. Deploy normal. Não precisa de nenhum SQL manual — é só o `schema.prisma`.

## Endpoints novos
- `POST /api/analytics/events` — público (aceita anónimo e autenticado), recebe `{ events: [...] }` em lote, tal como o `js/analytics.js` do frontend já envia. Responde sempre 200 mesmo que alguns eventos do lote sejam inválidos (só esses são descartados, não o lote todo).
- `GET /api/analytics/summary?from=&to=&event=` — só admin, contagem de eventos agrupada por tipo. Ponto de partida simples; se quiseres funil/drop-off calculado no servidor (não só os eventos crus), digo-me e construo isso a seguir.

## Ficheiros
- `prisma/schema.prisma` — novo `model AnalyticsEvent`
- `src/controllers/analyticsController.js` — novo
- `src/routes/analyticsRoutes.js` — novo
- `src/routes/index.js` — regista `/analytics`
