'use strict';

// Gera um slug amigável para URL a partir de texto livre (nome do
// produto, localização, etc). Remove acentos (comum em português —
// "Máquina", "São", "Educação"), espaços e caracteres especiais.
function slugify(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// Sufixo curto e aleatório para garantir unicidade sem depender de
// contagem sequencial (evita corrida entre publicações simultâneas).
function randomSuffix(len = 5) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Gera um slug único para um produto: nome + localização (se houver) +
// sufixo aleatório. `checkExists` é uma função async(slug) => boolean
// fornecida pelo chamador (ex: consulta ao Prisma), para tentar de novo
// no raríssimo caso de colisão do sufixo.
async function uniqueProductSlug({ name, location }, checkExists) {
  const base = slugify([name, location].filter(Boolean).join(' ')) || 'produto';
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `${base}-${randomSuffix()}`;
    if (!checkExists || !(await checkExists(candidate))) return candidate;
  }
  // Fallback extremamente improvável de acontecer
  return `${base}-${randomSuffix(8)}`;
}

module.exports = { slugify, randomSuffix, uniqueProductSlug };
