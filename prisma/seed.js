'use strict';

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 A semear a base de dados...\n');

  // ─── Create Admin Account ───────────────────────────────────────
  const adminEmail = process.env.ADMIN_EMAIL || 'ayronbanze0@gmail.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'C@m@le@o';
  const adminName = process.env.ADMIN_NAME || 'Ayron Banze';

  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });

  if (existingAdmin) {
    console.log(`✓ Conta de administrador já existe: ${adminEmail}`);
  } else {
    const passwordHash = await bcrypt.hash(adminPassword, parseInt(process.env.BCRYPT_ROUNDS) || 12);
    const admin = await prisma.user.create({
      data: {
        name: adminName,
        email: adminEmail,
        passwordHash,
        role: 'ADMIN',
        verified: true,
        active: true,
        onboardedAt: new Date(),
        emailVerifiedAt: new Date()
      }
    });
    console.log(`✅ Conta de administrador criada com sucesso:`);
    console.log(`   Email: ${admin.email}`);
    console.log(`   Senha: ${adminPassword}`);
    console.log(`   ID: ${admin.id}\n`);
  }

  // ─── Create BazarBot system account ─────────────────────────────
  // Sem isto, getBazarBotUserId() (chatController.js / chatSocket.js)
  // nunca encontra nenhum utilizador com isBazarBot=true — o endpoint
  // GET /api/chat/bazarbot devolve sempre 404 "BazarBot ainda não está
  // configurado" e a funcionalidade fica permanentemente por activar,
  // porque não havia nenhum sítio no código que criasse esta conta.
  const botEmail = process.env.BAZARBOT_EMAIL || 'bazarbot@bazares.co.mz';

  const existingBot = await prisma.user.findFirst({ where: { isBazarBot: true } });

  if (existingBot) {
    console.log(`✓ Conta BazarBot já existe: ${existingBot.email}`);
  } else {
    // Password aleatória — esta conta nunca faz login, só existe como
    // remetente de mensagens (senderId em Message/Chat).
    const botPasswordHash = await bcrypt.hash(
      require('crypto').randomBytes(24).toString('hex'),
      parseInt(process.env.BCRYPT_ROUNDS) || 12
    );
    const bot = await prisma.user.create({
      data: {
        name: 'BazarBot',
        email: botEmail,
        passwordHash: botPasswordHash,
        role: 'ADMIN',
        verified: true,
        active: true,
        isBazarBot: true,
        onboardedAt: new Date(),
        emailVerifiedAt: new Date(),
        bio: 'Assistente de suporte automático do Bazares.'
      }
    });
    console.log(`✅ Conta BazarBot criada com sucesso: ${bot.email} (id: ${bot.id})\n`);
  }

  console.log('🎉 Seed concluído com sucesso!\n');
  console.log('Pode agora iniciar sessão no painel administrativo com:');
  console.log(`  Email: ${adminEmail}`);
  console.log(`  Senha: ${adminPassword}\n`);
}

main()
  .catch((e) => {
    console.error('❌ Erro ao semear a base de dados:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
