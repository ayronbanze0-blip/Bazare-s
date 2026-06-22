# Bazares — Backend API

Backend completo e profissional para o marketplace **Bazares**, construído com Node.js, Express, PostgreSQL (via Prisma ORM), JWT, Socket.IO e Cloudinary.

---

## 📋 Stack Tecnológica

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express.js |
| Base de dados | PostgreSQL |
| ORM | Prisma |
| Autenticação | JWT (access + refresh tokens) + bcrypt |
| Upload de imagens | Multer + Cloudinary |
| Chat em tempo real | Socket.IO |
| Email | Nodemailer (Gmail SMTP) |
| Segurança | Helmet, CORS, express-rate-limit, xss |
| Logs | Winston |

---

## 🚀 Instalação — Passo a Passo

### 1. Pré-requisitos

Antes de começar, precisa de ter instalado:

- **Node.js** versão 18 ou superior → [nodejs.org](https://nodejs.org)
- **PostgreSQL** (local ou na nuvem) → recomendamos [Neon.tech](https://neon.tech) ou [Supabase](https://supabase.com) (planos gratuitos)
- Uma conta **Cloudinary** gratuita → [cloudinary.com](https://cloudinary.com) (para upload de imagens)
- Uma conta **Gmail** com "Password de Aplicação" activada → para envio de emails

### 2. Instalar dependências

Abra o terminal na pasta do projecto e execute:

```bash
npm install
```

Isto vai instalar todas as bibliotecas listadas no `package.json` (Express, Prisma, JWT, Socket.IO, etc.)

### 3. Configurar variáveis de ambiente

Copie o ficheiro de exemplo:

```bash
cp .env.example .env
```

Depois abra o ficheiro `.env` e preencha com os seus dados reais:

```env
DATABASE_URL="postgresql://utilizador:senha@host:5432/bazares_db"
JWT_ACCESS_SECRET=escreva_uma_string_aleatoria_longa_aqui
JWT_REFRESH_SECRET=outra_string_aleatoria_diferente_aqui
SMTP_USER=bazares09@gmail.com
SMTP_PASS=a_sua_password_de_aplicacao_gmail
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
ADMIN_EMAIL=ayronbanze0@gmail.com
ADMIN_PASSWORD=C@m@le@o
```

> 💡 **Como obter a DATABASE_URL gratuitamente:**
> 1. Crie conta em [neon.tech](https://neon.tech)
> 2. Crie um novo projecto PostgreSQL
> 3. Copie a "Connection String" fornecida e cole em `DATABASE_URL`

> 💡 **Como obter a Password de Aplicação do Gmail:**
> 1. Aceda a [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
> 2. Active a verificação em 2 passos se ainda não tiver
> 3. Gere uma "Password de Aplicação" para "Email"
> 4. Cole essa password (16 caracteres) em `SMTP_PASS`

> 💡 **Como obter credenciais Cloudinary gratuitas:**
> 1. Crie conta em [cloudinary.com](https://cloudinary.com)
> 2. No Dashboard, copie: Cloud Name, API Key, API Secret

### 4. Criar a estrutura da base de dados

Execute as migrações do Prisma (isto cria todas as tabelas):

```bash
npm run db:push
```

Ou, para usar migrations versionadas (recomendado em produção):

```bash
npm run db:migrate
```

### 5. Gerar o cliente Prisma

```bash
npm run db:generate
```

### 6. Semear a base de dados (criar conta admin)

```bash
npm run db:seed
```

Isto cria automaticamente a conta de administrador:
- **Email:** ayronbanze0@gmail.com
- **Senha:** C@m@le@o

### 7. Iniciar o servidor

Em modo desenvolvimento (recarrega automaticamente ao editar ficheiros):

```bash
npm run dev
```

Em modo produção:

```bash
npm start
```

O servidor vai arrancar em `http://localhost:3001` (ou na porta definida em `PORT`).

### 8. Verificar que está a funcionar

Abra o navegador ou use `curl`:

```bash
curl http://localhost:3001/api/health
```

Deve receber:
```json
{ "success": true, "message": "Bazares API está operacional." }
```

---

## 📁 Estrutura do Projecto

```
bazares/
├── prisma/
│   ├── schema.prisma       # Modelo completo da base de dados
│   └── seed.js             # Script que cria a conta admin
├── src/
│   ├── controllers/        # Lógica de negócio de cada recurso
│   ├── routes/              # Definição de endpoints da API
│   ├── middleware/          # Auth, rate limiting, erros, auditoria
│   ├── services/            # Email, upload, notificações
│   ├── sockets/              # Chat em tempo real (Socket.IO)
│   ├── utils/                # Helpers, logger, respostas padronizadas
│   ├── app.js                # Configuração do Express
│   └── server.js             # Ponto de entrada (HTTP + Socket.IO)
├── uploads/temp/             # Pasta temporária para uploads
├── logs/                     # Logs da aplicação (Winston)
├── .env.example               # Modelo de variáveis de ambiente
└── package.json
```

---

## 🔌 Endpoints Principais da API

Todos os endpoints começam com `/api`.

### Autenticação (`/api/auth`)
| Método | Rota | Descrição |
|---|---|---|
| POST | `/register` | Criar conta |
| POST | `/verify-email` | Verificar código de email |
| POST | `/resend-verification` | Reenviar código |
| POST | `/login` | Iniciar sessão |
| POST | `/refresh` | Renovar token de acesso |
| POST | `/logout` | Terminar sessão |
| POST | `/forgot-password` | Solicitar redefinição |
| POST | `/reset-password` | Redefinir palavra-passe |
| GET | `/me` | Dados do utilizador autenticado |

### Produtos (`/api/products`)
| Método | Rota | Descrição |
|---|---|---|
| GET | `/` | Listar produtos (público, com filtros) |
| GET | `/:id` | Ver produto |
| GET | `/me/list` | Meus produtos (vendedor) |
| POST | `/` | Criar produto (com upload de imagens) |
| PUT | `/:id` | Editar produto |
| PATCH | `/:id/toggle` | Activar/desactivar |
| POST | `/:productId/favorite` | Adicionar/remover favorito |

### Bazares (`/api/bazars`)
| Método | Rota | Descrição |
|---|---|---|
| GET | `/` | Listar bazares |
| GET | `/:idOrSlug` | Ver bazar |
| GET | `/me` | O meu bazar |
| POST | `/` | Criar bazar |
| PUT | `/me` | Editar o meu bazar |

### Encomendas (`/api/orders`)
| Método | Rota | Descrição |
|---|---|---|
| POST | `/` | Fazer encomenda |
| GET | `/mine` | As minhas encomendas (comprador) |
| GET | `/received` | Encomendas recebidas (vendedor) |
| PATCH | `/:id/status` | Actualizar estado |
| POST | `/:id/review` | Avaliar |

### Chat (`/api/chat`)
| Método | Rota | Descrição |
|---|---|---|
| GET | `/` | Minhas conversas |
| GET | `/with/:userId` | Obter/criar conversa |
| GET | `/:chatId/messages` | Histórico de mensagens |
| POST | `/:chatId/messages` | Enviar mensagem (REST) |

> 💬 Para chat em **tempo real**, o frontend deve conectar-se via Socket.IO (ver secção abaixo).

### Administração (`/api/admin`) — requer conta ADMIN
| Método | Rota | Descrição |
|---|---|---|
| GET | `/overview` | Estatísticas da plataforma |
| GET | `/users` | Listar utilizadores |
| PATCH | `/users/:id/toggle` | Suspender/reactivar |
| PATCH | `/users/:id/verify-seller` | Verificar vendedor |
| POST | `/broadcast` | Enviar aviso geral |
| GET | `/reports` | Ver denúncias |
| GET | `/audit-logs` | Auditoria |

### Revendedores (`/api/revendedor`)
| Método | Rota | Descrição |
|---|---|---|
| POST | `/invites` | Gerar convite (admin) |
| GET | `/me/sellers` | Meus vendedores |
| GET | `/me/referrals` | Estatísticas de referência |

---

## 🔌 Integração Socket.IO (Chat em Tempo Real)

No frontend, conecte-se assim:

```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3001', {
  auth: { token: accessToken } // token JWT obtido no login
});

// Entrar numa conversa
socket.emit('chat:join', { chatId: 'abc123' });

// Enviar mensagem
socket.emit('message:send', { chatId: 'abc123', text: 'Olá!' });

// Receber mensagens em tempo real
socket.on('message:new', (message) => {
  console.log('Nova mensagem:', message);
});

// Indicador "a escrever"
socket.emit('typing:start', { chatId: 'abc123' });
socket.on('typing:start', ({ userId }) => console.log(`${userId} está a escrever...`));

// Notificações em tempo real
socket.on('notification', (notif) => console.log('Nova notificação:', notif));
```

---

## 🔒 Segurança Implementada

- ✅ Senhas com hash bcrypt (12 rounds)
- ✅ JWT access token (15 min) + refresh token (7 dias, httpOnly cookie)
- ✅ Cookie de sessão com `sameSite: 'none'` + `secure: true` em produção — necessário porque o frontend (ex: Vercel) e o backend (ex: Railway) vivem em domínios diferentes; `'strict'`/`'lax'` bloqueariam o cookie silenciosamente nesse cenário
- ✅ Rotação de refresh tokens
- ✅ Rate limiting (geral + login mais restrito)
- ✅ Proteção contra força bruta (bloqueio após 5 tentativas falhadas)
- ✅ Helmet (cabeçalhos HTTP seguros + CSP, sem wildcards quando há credenciais)
- ✅ CORS com lista explícita de origens permitidas (nunca `*` combinado com `credentials: true` — essa combinação é rejeitada pelos navegadores e quebraria o login)
- ✅ Sanitização de inputs (proteção XSS)
- ✅ Validação robusta com express-validator
- ✅ Verificação de variáveis de ambiente obrigatórias no arranque (falha rápido e com mensagem clara em vez de comportamento indefinido)
- ✅ Logs de auditoria de todas as acções sensíveis

> ⚠️ **Importante sobre `FRONTEND_URL`:** suporta múltiplas origens separadas por vírgula (ex: `https://bazares.co.mz,https://staging.bazares.co.mz`). Sem esta variável definida em produção, o CORS permite qualquer origem mas SEM credenciais — ou seja, a API responde mas o login não persiste. Configure-a sempre antes de publicar.

---

## 🗄️ Migrar para produção

1. Crie uma base de dados PostgreSQL em produção (Neon, Supabase, Railway, ou um VPS)
2. Actualize `DATABASE_URL` no `.env` de produção
3. Execute `npm run db:migrate:deploy` no ambiente de produção (versão não-interactiva de `db:migrate`, segura para CI/CD)
4. Execute `npm run db:seed` uma única vez
5. Defina `NODE_ENV=production`
6. Use um gestor de processos como **PM2**: `pm2 start src/server.js --name bazares-api`
7. Configure um proxy reverso (Nginx) com HTTPS (Let's Encrypt)

---

## 🧪 Testar a API rapidamente

```bash
# Registar um vendedor
curl -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Maria Teste","email":"maria@teste.com","password":"senha12345","role":"SELLER"}'

# Login
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ayronbanze0@gmail.com","password":"C@m@le@o"}'
```

---

## 📞 Suporte

Para dúvidas sobre este backend, consulte os comentários no código — cada controller e serviço está documentado com a sua responsabilidade específica.
