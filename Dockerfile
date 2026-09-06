FROM node:18-slim

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl ca-certificates postgresql-client && rm -rf /var/lib/apt/lists/*

COPY . .

RUN npm install

EXPOSE 3001

CMD ["sh", "-c", "if [ -d prisma/migrations ] && [ \"$(ls -A prisma/migrations 2>/dev/null)\" ]; then npx prisma migrate deploy; else echo 'AVISO: prisma/migrations não existe ou está vazio — a usar db push como fallback. Crie uma migration baseline (prisma migrate dev) e commit prisma/migrations para produção usar migrate deploy.'; npx prisma db push --accept-data-loss; fi && (node scripts/backfill-product-slugs.js || true) && npm start"]
