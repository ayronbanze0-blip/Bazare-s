# Wallet Bazares — Guia de Implementação

## ⚠️ IMPORTANTE: ordem de upload

Como subes via interface mobile do GitHub, segue esta ordem **exacta** para
não partires nada a meio:

### 1. Backend — primeiro o schema, depois o resto

**a) `prisma/schema.prisma`** — SUBSTITUI o ficheiro completo.

**b) Depois de fazer push do schema, no Railway corre:**
```
npx prisma db push
```
(Settings → vai à aba de Deploy Logs ou usa o terminal do Railway / um
"one-off command". Se não souberes como correr comandos no Railway,
diz-me que te explico passo a passo.)

**c) Ficheiros NOVOS (criar):**
- `src/services/walletService.js`
- `src/services/zumboPayService.js`
- `src/controllers/walletController.js`
- `src/routes/walletRoutes.js`
- `src/routes/webhookRoutes.js`

**d) Ficheiros para SUBSTITUIR (já existem no repo):**
- `src/app.js`
- `src/routes/index.js`
- `src/controllers/financeController.js`
- `src/controllers/userController.js`
- `.env.example` (apenas referência — depois acrescenta as variáveis reais no `.env` e nas Variables do Railway)

### 2. Variáveis de ambiente no Railway

Vai a Railway → o teu serviço → **Variables** e acrescenta:

```
PLATFORM_ADMIN_EMAIL=<o email da conta admin que vai receber a comissão>
MIN_WITHDRAWAL_MT=1000

ZUMBOPAY_API_KEY=<a tua chave zk_live_...>
ZUMBOPAY_MERCHANT_ID=<o teu MCH_XXXXXXXXXX>
ZUMBOPAY_BASE_URL=https://zumbopay.com/api/public/v1
ZUMBOPAY_WALLET_MPESA=<wallet_id da carteira M-Pesa — ver abaixo>
ZUMBOPAY_WALLET_EMOLA=<wallet_id da carteira e-Mola — ver abaixo>
ZUMBOPAY_WEBHOOK_SECRET=<o secret do webhook>
```

**Para obter os `wallet_id`:** no painel ZumboPay → Carteiras, ou chama
`GET /api/public/v1/wallets` com a tua API key e copia o campo `id` de
cada carteira (M-Pesa e e-Mola).

**Para configurar o webhook:** no painel ZumboPay → Developers →
Webhooks, define a URL como:
```
https://bazare-s-production.up.railway.app/webhooks/zumbopay
```
e activa os eventos `payment.succeeded` e `payment.failed`. Copia o
`secret` gerado para `ZUMBOPAY_WEBHOOK_SECRET`.

### 3. Frontend

**Ficheiros NOVOS (criar):**
- `wallet.html`
- `wallet-history.html`
- `admin-wallet.html`

**Ficheiros para SUBSTITUIR:**
- `js/app.js` ⚠️ **ATENÇÃO**: confirma que o nome fica exactamente
  `app.js` ao subires — já tiveste o problema do GitHub mobile renomear
  para `app-3.js`. Verifica sempre o nome final no repo antes de sair.
- `dashboard.html`
- `finance.html`
- `admin-finance.html`

## Como testar depois de tudo no ar

1. Login como ADMIN → vai a `admin-wallet.html` → deve aparecer "ZumboPay
   configurada" se as env vars estiverem certas. Se aparecer "não
   configurada", confirma as variáveis no Railway.
2. Login como SELLER com contribuição pendente → `wallet.html` → deve
   aparecer o botão de pagar (saldo da wallet ou STK).
3. Testa um depósito manual: pede depósito como BUYER, aprova como ADMIN
   em `admin-wallet.html`, confirma que o saldo aparece em `wallet.html`.
4. Testa uma transferência entre duas contas de teste.

## O que ficou por implementar / decisões tomadas

- **Comissão automática**: substitui o sistema antigo de "dívida +
  comprovativo manual" — `bazar.pendingFees` continua a acumular 2% por
  venda exactamente como antes, só o PAGAMENTO mudou (agora instantâneo
  via wallet ou STK).
- **Levantamentos e depósitos de utilizadores**: continuam manuais
  (pedido → aprovação do admin) — não usei o `/payouts` da ZumboPay para
  isto porque essa funcionalidade move dinheiro da TUA conta ZumboPay,
  não dos utilizadores do Bazares.
- **Fallback**: se a ZumboPay não estiver configurada, o botão STK fica
  desactivado mas o pagamento via saldo da wallet continua a funcionar
  sempre.
- **Pagamentos split / recorrentes / checkout hospedado** da ZumboPay
  não foram usados — ficam disponíveis para uma fase futura (ex: cobrar
  directamente o comprador em vez de pagamento na entrega).

## Testes de contrato (backend ↔ frontend)

O ficheiro `tests/contract/api-contract.json` é a fonte única de
verdade das chaves que o frontend lê de cada resposta (`res.data.X`).
`tests/contract/response-shape.test.js` chama os controllers
directamente (Prisma mockado — não precisa de base de dados nem de
rede) e falha se algum controller devolver uma chave diferente da que
está documentada. Isto existe por causa de um bug real: a listagem de
Favoritos devolvia `{ favorites: [...] }` mas o frontend lia
`res.data.products`, e a página ficava sempre vazia, sem nenhum erro
visível.

Regra ao mexer num endpoint: actualizar primeiro o `api-contract.json`
(e o ficheiro do frontend que lê essa chave), só depois o controller.

```bash
npm install
npm test
```
