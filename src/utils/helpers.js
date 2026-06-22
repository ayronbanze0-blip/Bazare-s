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

module.exports = {
  toSlug, uniqueSlug, sanitize, genToken, genCode,
  expiresAt, fmtMT, paginate, paginateMeta, pick, omit, calcFee
};
