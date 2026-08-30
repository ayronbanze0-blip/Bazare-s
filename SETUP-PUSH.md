# Fase 3 — o que falta fazer manualmente para o FCM nativo funcionar

O código já está todo pronto (registo de token, canais, toques em
notificação a abrir o ecrã certo). Faltam só 2 coisas que só tu
consegues fazer (precisam da tua conta Firebase/GitHub):

## 1. Registar a app Android no projecto Firebase existente

O projecto Firebase já existe (`bazares-f1de9`, o mesmo do push web) —
só falta adicionar-lhe a app Android:

1. [Firebase Console](https://console.firebase.google.com) → projecto
   **bazares-f1de9** → ⚙️ **Definições do projeto** → separador
   **As tuas apps** → **Adicionar app** → Android.
2. **Nome do pacote Android**: `co.mz.bazares.app` (tem de ser exactamente
   este — é o `appId` do `capacitor.config.json`).
3. Descarrega o `google-services.json` que a Firebase gera.
4. Não o metas directamente no repositório (fica público) — em vez
   disso, cria um **secret** no GitHub:
   - No repositório → **Settings** → **Secrets and variables** →
     **Actions** → **New repository secret**
   - Nome: `GOOGLE_SERVICES_JSON_BASE64`
   - Valor: o conteúdo do ficheiro **convertido para base64**. No
     telemóvel/computador onde tiveres o ficheiro:
     ```
     base64 -i google-services.json | tr -d '\n'
     ```
     (no Windows/PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("google-services.json"))`)
   - Cola o resultado como valor do secret.
5. Corre o workflow outra vez — o passo "Add google-services.json" já
   vai encontrar o secret e escrever o ficheiro no sítio certo.

Sem isto: a app continua a compilar normalmente, só que sem push
nativo (o plugin regista mas nunca recebe nada, porque não há
credenciais Firebase do lado Android).

## 2. Ícone das notificações (opcional, mas recomendado)

O Android exige que o ícone da barra de notificações seja **uma
silhueta branca com fundo transparente** (não pode ter cor nem fundo —
o sistema recusa e mostra um quadrado genérico se não for assim).

Sem um ícone dedicado, o workflow usa o ícone normal da app como
reserva só para a build não falhar — mas vai aparecer mal na barra de
estado (quadrado colorido em vez de silhueta).

Quando tiveres esse ficheiro pronto (ex.: só o saco/logo em branco,
sem o fundo verde, ~256×256, PNG com transparência), guarda-o em:

```
resources/notification-icon.png
```

e faz push — o workflow ("Add native notification icon") passa a
usá-lo automaticamente, sem mais nada a mudar.

## 3. Backend — confirmar o endpoint de token

O código novo reutiliza o mesmo endpoint que o push web já usa —
`POST /notifications/device-token` — só muda o campo `platform` para
`'android'` (web manda `'web'`/`'pwa'`). Não mexi no backend (não está
neste repositório); confirma só que ele aceita esse valor sem
rejeitar, e que quando envia a notificação usa o mesmo formato
`data: { title, body, link }` que já usa hoje (é o que o código nativo
espera para saber que ecrã abrir ao tocar).
