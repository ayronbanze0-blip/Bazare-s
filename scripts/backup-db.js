'use strict';

// ─── Backup da base de dados ────────────────────────────────────────
// Corre `pg_dump`, comprime o resultado e envia-o para o Cloudinary
// (resource_type: 'raw'), reutilizando as credenciais que já existem
// para as imagens — não precisas de configurar mais nenhum serviço.
//
// Mantém apenas os últimos BACKUP_KEEP backups; os mais antigos são
// apagados do Cloudinary automaticamente.
//
// Uso local:   node scripts/backup-db.js
// Em produção: corre como serviço à parte no Railway com "Cron
// Schedule" (ver instruções que o Claude te deu na conversa).

require('dotenv').config();
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const cloudinary = require('cloudinary').v2;
const logger = require('../src/utils/logger');

const execFileAsync = promisify(execFile);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const BACKUP_FOLDER = 'bazares/backups';
const BACKUP_KEEP = parseInt(process.env.BACKUP_KEEP) || 14; // dias/backups a manter

const run = async () => {
  if (!process.env.DATABASE_URL) {
    logger.error('[Backup] DATABASE_URL não definida — abortado.');
    process.exit(1);
  }
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    logger.error('[Backup] Credenciais Cloudinary em falta — abortado.');
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpPath = path.join(os.tmpdir(), `bazares-${stamp}.sql`);
  const gzPath = `${dumpPath}.gz`;

  try {
    // 1) Dump em formato SQL simples (plain text), fácil de inspecionar/restaurar
    logger.info('[Backup] A correr pg_dump...');
    await execFileAsync('pg_dump', [process.env.DATABASE_URL, '-f', dumpPath, '--no-owner', '--no-privileges']);

    // 2) Comprimir
    logger.info('[Backup] A comprimir...');
    const input = fs.createReadStream(dumpPath);
    const output = fs.createWriteStream(gzPath);
    await new Promise((resolve, reject) => {
      input.pipe(zlib.createGzip()).pipe(output).on('finish', resolve).on('error', reject);
    });
    const sizeMb = (fs.statSync(gzPath).size / 1024 / 1024).toFixed(2);

    // 3) Upload para Cloudinary como ficheiro "raw" (não é imagem)
    logger.info(`[Backup] A enviar (${sizeMb} MB) para Cloudinary...`);
    const result = await cloudinary.uploader.upload(gzPath, {
      resource_type: 'raw',
      folder: BACKUP_FOLDER,
      public_id: `bazares-${stamp}`,
      use_filename: true
    });
    logger.info(`[Backup] Concluído: ${result.public_id}`);

    // 4) Limpar ficheiros temporários locais
    fs.unlink(dumpPath, () => {});
    fs.unlink(gzPath, () => {});

    // 5) Apagar backups antigos, mantendo só os últimos BACKUP_KEEP
    await pruneOldBackups();

    logger.info('[Backup] Concluído com sucesso.');
    process.exit(0);
  } catch (err) {
    logger.error(`[Backup] Falhou: ${err.message}`, { stack: err.stack });
    fs.unlink(dumpPath, () => {});
    fs.unlink(gzPath, () => {});
    process.exit(1);
  }
};

const pruneOldBackups = async () => {
  const { resources } = await cloudinary.api.resources({
    type: 'upload',
    resource_type: 'raw',
    prefix: `${BACKUP_FOLDER}/`,
    max_results: 200,
    sort_by: [['created_at', 'desc']]
  });

  const toDelete = resources.slice(BACKUP_KEEP).map(r => r.public_id);
  if (toDelete.length === 0) return;

  logger.info(`[Backup] A apagar ${toDelete.length} backup(s) antigo(s)...`);
  await cloudinary.api.delete_resources(toDelete, { resource_type: 'raw' });
};

run();
