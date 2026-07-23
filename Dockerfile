FROM node:18-slim

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl ca-certificates postgresql-client && rm -rf /var/lib/apt/lists/*

COPY . .

RUN npm install

EXPOSE 3001

CMD ["sh", "-c", "npx prisma db push && npm start"]
