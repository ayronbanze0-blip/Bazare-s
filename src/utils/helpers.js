'use strict';

const crypto = require('crypto');
const xss = require('xss');

/**
 * Generate URL-safe slug from string
 */
const toSlug = (str) =>
  str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

/**
 * Generate unique slug (appends random suffix if base exists)
 */
const uniqueSlug = async (prisma, base, model = 'bazar', id = null) => {
  const baseSlug = toSlug(base);
  let slug = baseSlug;
  let counter = 1;
  while (true) {
    const existing = await prisma[model].findFirst({
      where: { slug, ...(id && { id: { not: id } }) }
    });
    if (!existing) break;
    slug = `${baseSlug}-${counter++}`;
  }
  return slug;
};

/**
 * Sanitize user input to prevent XSS
 */
const sanitize = (str) => (str ? xss(String(str).trim()) : '');

/**
 * Generate cryptographically secure random token
 */
const genToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

/**
 * Generate 6-digit verification code
 */
const genCode = () => Math.floor(100000 + Math.random() * 900000).toString();

/**
 * Calculate expiry date
 */
const expiresAt = (minutes = 15) => new Date(Date.now() + minutes * 60 * 1000);

/**
 * Format currency for MT
 */
const fmtMT = (amount) => `${Number(amount || 0).toLocaleString('pt-MZ')} MT`;

/**
 * Paginate helper for Prisma queries
 */
const paginate = (page = 1, limit = 20) => {
  const take = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
  const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;
  return { take, skip };
};

/**
 * Build pagination metadata
 */
const paginateMeta = (total, page, limit) => ({
  total,
  page: parseInt(page) || 1,
  limit: parseInt(limit) || 20,
  pages: Math.ceil(total / (parseInt(limit) || 20))
});

/**
 * Pick only specified keys from object (safe serialization)
 */
const pick = (obj, keys) =>
  keys.reduce((acc, key) => {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key)) acc[key] = obj[key];
    return acc;
  }, {});

/**
 * Omit specified keys from object
 */
const omit = (obj, keys) => {
  const result = { ...obj };
  keys.forEach(k => delete result[k]);
  return result;
};

/**
 * Calculate platform fee
 */
const calcFee = (amount, rate = 2.0) =>
  Math.round(amount * (rate / 100) * 100) / 100;

/**
 * Início da semana corrente (segunda-feira 00:00) e do mês corrente,
 * usados para "visitas desta semana" e "vendas deste mês" (medalhas).
 */
const startOfWeek = (d = new Date()) => {
  const date = new Date(d);
  const day = date.getDay(); // 0=Domingo
  const diff = (day === 0 ? -6 : 1) - day; // volta até segunda-feira
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + diff);
  return date;
};

const startOfMonth = (d = new Date()) => {
  const date = new Date(d);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date;
};

/**
 * Sistema de medalhas por vendas concluídas no mês corrente:
 *   Bronze — 0 a 30 vendas/mês
 *   Prata  — 30 a 50 vendas/mês
 *   Ouro   — mais de 50 vendas/mês
 * Vendedores Ouro aparecem no topo das listagens de bazares.
 */
const getBadgeTier = (monthlySales = 0) => {
  const sales = Number(monthlySales) || 0;
  if (sales > 50) return { tier: 'OURO', label: 'Ouro', icon: '🥇', rank: 3 };
  if (sales >= 30) return { tier: 'PRATA', label: 'Prata', icon: '🥈', rank: 2 };
  return { tier: 'BRONZE', label: 'Bronze', icon: '🥉', rank: 1 };
};

module.exports = {
  toSlug, uniqueSlug, sanitize, genToken, genCode,
  expiresAt, fmtMT, paginate, paginateMeta, pick, omit, calcFee,
  startOfWeek, startOfMonth, getBadgeTier
};
