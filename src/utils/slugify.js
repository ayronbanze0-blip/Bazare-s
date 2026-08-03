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

// Gera uma alcunha única ("@joaomatavel") a partir do nome, para o
// sistema de menções. Diferente do slug de produto: sem hífens (fica
// mais parecido com um "handle" de rede social) e sempre com pelo
// menos 3 caracteres. `checkExists` é async(username) => boolean.
async function uniqueUsername(name, checkExists) {
  let base = slugify(name).replace(/-/g, '').slice(0, 20);
  if (base.length < 3) base = ('user' + base).slice(0, 20);
  if (!checkExists || !(await checkExists(base))) return base;
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `${base}${Math.floor(1000 + Math.random() * 9000)}`.slice(0, 24);
    if (!(await checkExists(candidate))) return candidate;
  }
  return `${base}${randomSuffix(6)}`.slice(0, 30);
}

module.exports = { slugify, randomSuffix, uniqueProductSlug, uniqueUsername };
