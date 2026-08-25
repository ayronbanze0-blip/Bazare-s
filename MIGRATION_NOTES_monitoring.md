# Error Tracking / Crash Reporting / Performance / Web Vitals / Alerting — como aplicar

Não construí um sistema paralelo do zero: descobri que já tinhas Sentry
ligado dos dois lados (backend `@sentry/node`, frontend via CDN em
`js/config.js`), só que incompleto — reforcei isso, e complementei com
os teus próprios dados (tabela `AnalyticsEvent`, já criada na Ronda 51)
para dares uma olhadela rápida sem abrir o dashboard do Sentry.

## O que mudou

**Backend**
- `src/app.js` — `Sentry.setupExpressErrorHandler(app)` adicionado (API
  nova do SDK v8; sem isto, erros lançados directamente numa rota podiam
  não chegar ao Sentry com o contexto completo)
- `src/middleware/auth.js` — `Sentry.setUser({id, role})` em toda a
  autenticação (obrigatória e opcional) — sem isto, todo erro no Sentry
  aparecia como "utilizador desconhecido"; agora dá para ver quantas
  PESSOAS diferentes foram afectadas por cada problema, não só quantas
  vezes aconteceu
- `src/controllers/analyticsController.js` — dois novos tipos de evento
  aceites (`api_error`, `api_slow`, `client_error`) + novo endpoint
  `GET /api/analytics/routes-health?hours=24` (admin): lista as rotas
  que mais falharam/ficaram lentas nas últimas N horas, com quantos
  utilizadores diferentes cada uma afectou

**Frontend**
- `js/config.js` — Sentry trocado do bundle "base" (só crashes) para o
  bundle "tracing" (`bundle.tracing.min.js`) + `browserTracingIntegration()`
  → isto é o que liga Performance Monitoring e Web Vitals (LCP/CLS/INP)
  a sério; antes, `tracesSampleRate` estava definido mas sem efeito
  nenhum, porque faltava esta integração
- `js/api.js` — cada chamada à API agora mede a duração; se falhar ou
  demorar mais de 3s, reporta ao Sentry (breadcrumb) E à tua própria
  tabela `AnalyticsEvent` (evento `api_error`/`api_slow`, com rota,
  método, estado HTTP e duração)
- `js/core.js` — `Bazares.Error` (já existia) passou a alimentar também
  a tua tabela própria (evento `client_error`), além do Sentry; e passou
  a ligar o utilizador logado ao Sentry automaticamente (login/logout)

## Passos para aplicar
1. `git pull` / copiar estes ficheiros.
2. Deploy normal — o Dockerfile já corre `prisma db push` sozinho, os
   dois novos tipos de evento não precisam de migração de schema (usam
   a tabela `AnalyticsEvent` que já existe desde a Ronda 51).

## Configurar os ALERTAS (isto só se faz no dashboard do Sentry, não por código)
Vai a sentry.io → projecto do backend e do frontend (os DSN já estão
configurados) → **Alerts → Create Alert Rule**. Sugestão de 3 regras,
uma por cada coisa que pediste:

1. **"Uma rota está a falhar"** — Issue Alert: "An issue is seen more
   than 10 times in 5 minutes" → notificar por email.
2. **"Uma API está lenta"** — Metric Alert (Performance): "p95(transaction.duration)
   above 3000ms for 5 minutes", filtrado ao transaction que te interessa
   (ex.: `POST /api/orders`).
3. **"Muitos utilizadores a falhar na mesma acção"** — Issue Alert:
   "An issue affects more than 20 users in 1 hour" (é exactamente para
   isto que serve o `Sentry.setUser` que liguei agora).

Alternativa sem sair da app: `GET /api/analytics/routes-health` dá-te
já os números 1 e 3 em JSON, sem precisar do Sentry — pode ser a base
de um pequeno painel dentro do teu próprio admin, se preferires isso a
gerir alertas no Sentry.
