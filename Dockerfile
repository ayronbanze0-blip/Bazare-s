# Node 22 (LTS). Node 24 só depois de subir o Prisma para uma versão que o suporte
# oficialmente (o Prisma 5.x suporta até Node 22). Debian "bookworm" fixado de propósito:
# o Prisma 5 detecta o OpenSSL 3.0 do bookworm; imagens mais novas (trixie) podem falhar.
FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update -y \
 && apt-get install -y --no-install-recommends openssl ca-certificates postgresql-client \
 && rm -rf /var/lib/apt/lists/*

# 1) Só os ficheiros de dependências (+ schema, necessário ao `prisma generate` do postinstall)
#    -> a camada de `npm ci` fica em cache enquanto as dependências não mudarem.
COPY package.json package-lock.json* ./
COPY prisma ./prisma

# `npm ci` é o caminho correcto (instala EXACTAMENTE o que está no package-lock.json).
# Enquanto o lockfile não existir no repositório cai para `npm install` com AVISO, para não
# derrubar o deploy na transição. Com --build-arg STRICT_LOCKFILE=1 falha se faltar o lockfile.
ARG STRICT_LOCKFILE=0
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    elif [ "$STRICT_LOCKFILE" = "1" ]; then \
      echo "ERRO: package-lock.json em falta (STRICT_LOCKFILE=1)." >&2; exit 1; \
    else \
      echo "AVISO: package-lock.json em falta — a usar npm install (build NÃO reprodutível). Corra o workflow 'Gerar package-lock.json'."; \
      npm install --omit=dev; \
    fi

# 2) Código da aplicação
COPY . .
RUN chmod +x scripts/docker-entrypoint.sh && mkdir -p uploads/temp

ENV NODE_ENV=production
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Sem `sh -c`/npm no meio: o entrypoint termina com `exec node`, por isso o SIGTERM chega ao Node.
CMD ["sh", "scripts/docker-entrypoint.sh"]
