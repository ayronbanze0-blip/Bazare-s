FROM node:18-slim

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY . .

RUN npm install

EXPOSE 3001

CMD ["sh", "-c", "set -e; echo '[1] Pushing schema...'; npx prisma db push --accept-data-loss; echo '[2] Seeding database...'; node prisma/seed.js; echo '[3] Starting server...'; exec node src/server.js"]
