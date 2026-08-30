# Bazares — APK via Capacitor (código embutido, build 100% na nuvem)

Nada disto corre no teu telemóvel — tudo corre no GitHub Actions. Tu só
fazes upload dos ficheiros e descarregas o `.apk` no fim.

## Como está configurado agora

Ao contrário da primeira versão (que carregava sempre `bazares.pages.dev`
numa WebView), **o código do Bazares está todo dentro do APK**, na pasta
`www/`. Isso significa:

- A app funciona sem depender do site estar online para carregar a
  interface (HTML/CSS/JS, ícones, imagens) — tudo isso já vem instalado.
- As chamadas ao backend (login, produtos, encomendas, chat, etc.)
  continuam a ir para `https://bazare-s.onrender.com`, tal como no site —
  isso não muda, só a interface é que agora vem embutida.
- **Sempre que mudares o frontend**, tens de repetir o passo 2 (voltar a
  fazer upload da pasta `www/` actualizada) e correr o workflow outra vez
  para gerar um novo APK. Deixou de ser automático como na versão anterior.
- Ícone e splash screen nativos gerados a partir dos ficheiros que já
  tinhas em `icons/` (`icon-512.png` para o ícone, e um splash novo com o
  fundo `#F8FAFC` do teu `manifest.json` e o ícone centrado).

## O que foi deixado de fora do `www/`

- `functions/` — são Cloudflare Pages Functions (só correm no servidor,
  para partilhas com pré-visualização/SEO). Não fazem sentido dentro da
  app instalada.
- `_headers`, `_redirects`, `robots.txt`, `sitemap.xml`, `PLANO-100.md`,
  `PLANO-UX-VISUAL.md` — específicos do Cloudflare Pages ou documentação
  interna, sem efeito dentro do APK.

Tudo o resto (páginas, `css/`, `js/`, `icons/`, `images/`, `img/`,
`manifest.json`, `sw.js`, `firebase-messaging-sw.js`) foi copiado tal e
qual.

## Passo a passo (só telemóvel, GitHub app)

1. No repositório onde já tens os ficheiros anteriores, **substitui**:
   - `capacitor.config.json`
   - `package.json`
   - `.github/workflows/build-apk.yml`
2. **Adiciona** as pastas novas:
   - `www/` (todo o conteúdo — código do Bazares)
   - `resources/` (`icon.png` e `splash.png`, usados só durante o build
     para gerar os ícones/splash nativos)
3. Vai ao separador **Actions** → o workflow "Build APK (Capacitor)"
   deve começar sozinho. Se não, toca em **"Run workflow"**.
4. Espera ~4-6 minutos (agora demora um pouco mais, porque também gera os
   ícones/splash). Quando terminar (✅ verde), abre o run → **"Artifacts"**
   → `bazares-debug-apk` → descarrega o `.apk`.

## Pontos a saber já (não bloqueiam o teste, mas fica a saber)

- **Login com Google/Facebook**: dentro de uma WebView embutida (como a
  do Capacitor), o Google bloqueia por vezes o ecrã de login por razões
  de segurança ("disallowed_useragent"). O login com email/password
  funciona normalmente. Resolver isto bem (Google/Facebook nativos)
  precisa de configuração adicional na Google/Facebook Developer Console
  e de um plugin nativo — fica como próximo passo se quiseres avançar
  com isso.
- **Service Worker** (`sw.js`, cache offline): pensado para o site correr
  no browser; dentro do APK já não é tão necessário (o código já vem todo
  instalado), mas foi deixado tal como está — não deve causar problemas.

## Fase 2 — Navegação nativa (já feito)

- `www/js/native-shell.js` foi substituído por `www/js/native-bridge.js`
  (mesmo comportamento de botão voltar/status bar/teclado, agora com
  API central `window.BazaresNative` + tratamento de deep links).
- `www/js/spa-router.js` ganhou uma cache de DOM vivo por URL: ao
  voltar atrás (botão físico, gesto, ou `history.back()`), a página
  reaparece exactamente como foi deixada — mesma posição de scroll,
  mesmo feed carregado, sem voltar a pedir o HTML nem a correr os
  scripts outra vez (evita reload, listeners e componentes
  duplicados). Navegação para a frente continua sempre a pedir a
  versão fresca.
- Corrigido um conflito real que existia entre dois sistemas de "sair
  da app": o diálogo "Queres sair da Bazares?" (`app.js`) chamava
  `window.close()`, que não faz nada dentro do WebView nativo — passa
  a usar `BazaresNative.exitApp()` quando corre dentro da app.
- Bottom sheets, modais e gestos (arrastar para fechar, "peek") já
  estavam bem resolvidos em `Bazares.Modal`/`Bazares.Sheet` — não foi
  preciso mexer.

## Fase 3 — Notificações push nativas (código pronto, falta 1 passo teu)

- `www/js/push-notifications.js` ganhou um caminho nativo completo via
  `@capacitor/push-notifications` (permissão, registo de token, canal
  de notificação, toast em primeiro plano, abrir o ecrã certo ao tocar
  em background/app fechada) — as funções já usadas por
  `settings.html` (`requestPushPermission`, `isPushEnabled`,
  `disablePushNotifications`) continuam iguais, só passam a usar o
  caminho nativo quando corre dentro da app.
- `scripts/patch-android.py` liga o plugin `google-services` e a
  meta-data do ícone/cor/canal por omissão das notificações.
- **Falta só 1 coisa manual, do teu lado**: registar a app no Firebase
  e guardar o `google-services.json` como secret do GitHub — passo a
  passo em `SETUP-PUSH.md`. Sem isso a app continua a compilar
  normalmente, só sem push nativo.

## Fase 4 — Paridade browser ↔ app nativa (deep search)

Varrimento a todo o `www/` à procura de APIs de browser que ficam sem
efeito (ou partem mesmo) dentro da WebView nativa. `native-bridge.js`
ganhou helpers universais (`BazaresNative.share`, `.shareFile`,
`.copyToClipboard`, `.hapticLight`, `.getCurrentPosition`,
`.openExternal`) — tentam o plugin nativo dentro da app, caem para a
API de Web normal fora dela; o código que chama nunca precisa de saber
em qual das duas está.

- **Partilha/clipboard/vibração** — `suggestToFriend`, `nativeShare`,
  `copyShareLink`, o selo "Compra Feliz" (`app.js`), `copyBazarLink`,
  `printBazarQr` (`my-bazar.html` — o `window.open('',...)` +
  `document.write` partia mesmo dentro da app), `copyCodes`
  (`admin-premium.html`), o link de convite (`referrals.html`).
- **`window.open` para links externos** (WhatsApp) — fica sem efeito
  na WebView (sem handler de "nova janela"); `bazar.html` e
  `referrals.html` passaram a usar `BazaresNative.openExternal()`
  (navega o próprio WebView, que o Android entrega à app certa).
  A imagem do chat passou a abrir no lightbox interno em vez de
  `window.open`.
- **Geolocalização** — `maps.js` e a saudação por região do
  `index.html` passaram a usar `BazaresNative.getCurrentPosition()`;
  `patch-android.py` passou a declarar `ACCESS_FINE_LOCATION`/
  `ACCESS_COARSE_LOCATION` no manifest (sem isso ficava sempre sem
  resposta, nem sucesso nem erro).
- **`POST_NOTIFICATIONS`** também passou a ser declarada — obrigatória
  no Android 13+ para as notificações push aparecerem mesmo com o
  token registado.
- **Login social (Google/Facebook)** — confirmado que está mesmo
  quebrado dentro da app (o Google bloqueia OAuth em WebViews —
  "disallowed_useragent" — e o SDK do Facebook usa popup). Corrigir a
  sério precisa de um plugin de login nativo + configurar SHA-1/key
  hash nas consolas do Google/Facebook — fica para uma fase à parte.
  Por agora os botões avisam claramente em vez de falhar em silêncio.
- Novos plugins em `package.json`: `@capacitor/share`,
  `@capacitor/clipboard`, `@capacitor/haptics`, `@capacitor/geolocation`,
  `@capacitor/filesystem` (usado só para partilhar a imagem do selo de
  compra como ficheiro).

## Próximos passos (quando quiseres)

- **Build de release assinado** (para a Play Store) — o workflow actual
  gera só um APK de **debug**, bom para testares já. Para publicar
  precisamos de gerar uma keystore e assinar a build.
- **Login nativo Google/Facebook** — integrar plugins nativos em vez do
  fluxo web, para o login funcionar sem restrições dentro da app.
- **Nome/appId definitivos** — continua `co.mz.bazares.app` / "Bazares".
  Se quiseres outro `appId`, diz-me antes de publicares na Play Store
  (não dá para mudar depois).
