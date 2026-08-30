# App Links — o que falta do lado do site (bazares.co.mz)

O `AndroidManifest.xml` já fica preparado (via `scripts/patch-android.py`)
para abrir `https://bazares.co.mz/...` directamente na app, com
`autoVerify="true"`. Mas essa verificação automática do Android só passa
depois de publicares em `bazares.co.mz` (não no repositório do APK — no
site, tal como `manifest.json` ou `sw.js`):

```
https://bazares.co.mz/.well-known/assetlinks.json
```

com este conteúdo (troca `SHA256_AQUI` pela impressão digital real):

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "co.mz.bazares.app",
      "sha256_cert_fingerprints": ["SHA256_AQUI"]
    }
  }
]
```

**Onde arranjar a `SHA256_AQUI`:** só existe depois de teres uma keystore
de assinatura (agora o workflow só gera **debug**, que já tem uma
assinatura automática mas que muda a cada ambiente — não serve para
produção). Isto liga-se directamente ao "Build de release assinado" que
já estava listado no README como próximo passo. Quando gerares essa
keystore, corre:

```
keytool -list -v -keystore a-tua.keystore -alias o-teu-alias
```

e copia o valor de `SHA256` para o `assetlinks.json`.

Até lá, os deep links funcionam **dentro** da app normalmente (links
internos, notificações push a abrir páginas certas via
`BazaresNative.onDeepLink`), só a abertura automática a partir de um link
partilhado fora da app (WhatsApp, SMS, etc.) é que fica pendente desta
verificação.
