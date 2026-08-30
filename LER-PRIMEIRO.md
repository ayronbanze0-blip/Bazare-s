# O que fazer com esta pasta

Contém **só** os ficheiros que mudaram (ou são novos) nas Fases 1–4 —
mesmos caminhos do teu repositório `Bazares-APK`. Não é o projecto
completo, é só o "diff" para substituíres.

## Como aplicar

1. Copia o conteúdo desta pasta para dentro do teu repositório local,
   **substituindo** os ficheiros com o mesmo nome/caminho (68 ficheiros
   ao todo — a maioria são páginas `.html` que só tiveram 1 linha
   mudada, a referência ao script novo).
2. **Apaga** `www/js/native-shell.js` do teu repositório — foi
   substituído por `www/js/native-bridge.js` (está aqui dentro) e já
   não é usado por nenhuma página.
3. Confirma que ficaste com **os dois**: `www/js/native-bridge.js`
   (novo) e `www/js/spa-router.js`/`www/js/app.js`/etc.
   (actualizados) — nenhum deve faltar.
4. Faz commit e push para o `main` — o workflow do GitHub Actions
   dispara sozinho.

## Ficheiros novos (não existiam antes)
- `www/js/native-bridge.js`
- `scripts/patch-android.py`
- `SETUP-PUSH.md`
- `assetlinks-README.md`

## Ficheiro a apagar do teu repositório
- `www/js/native-shell.js` (substituído pelo `native-bridge.js` acima)

## Ficheiros actualizados (já existiam, só mudou conteúdo)
- `capacitor.config.json`, `package.json`,
  `.github/workflows/build-apk-capacitor.yml`, `README.md`
- `www/js/spa-router.js`, `www/js/app.js`, `www/js/push-notifications.js`,
  `www/js/maps.js`, `www/js/install-prompt.js`
- 55 páginas `.html` (todas as que carregavam `native-shell.js` — agora
  carregam `native-bridge.js`; algumas — `index.html`, `login.html`,
  `chat.html`, `bazar.html`, `referrals.html`, `my-bazar.html`,
  `admin-premium.html` — tiveram mais mudanças específicas da Fase 4)

Se preferires não mexer manualmente em 68 ficheiros, o zip completo do
repositório (`Bazares-APK-main-updated.zip`) que já te enviei antes tem
tudo isto dentro da estrutura toda — podes simplesmente substituir a
pasta inteira do projecto por essa, em vez de aplicar ficheiro a
ficheiro.
