'use strict';

/**
 * Configuração centralizada + validação de ambiente.
 *
 * Regras:
 *  - SEMPRE obrigatórias: DATABASE_URL, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET.
 *  - Em PRODUÇÃO também são obrigatórias (o arranque é impedido se faltarem):
 *      FRONTEND_URL (lista de origens http/https, sem "*"),
 *      ZUMBOPAY_WEBHOOK_SECRET (sem ele NENHUM webhook de pagamento é aceite),
 *      JWT secrets com >= 32 caracteres e diferentes entre si.
 *  - Só AVISO (funcionalidade degradada, mas o marketplace continua a funcionar):
 *      Cloudinary, SMTP, ZumboPay (chaves da API), Firebase.
 *
 * Sem dependências externas — testável com `node` puro (tests/unit/env.test.js).
 */

const ALWAYS_REQUIRED = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];
const PRODUCTION_REQUIRED = ['FRONTEND_URL', 'ZUMBOPAY_WEBHOOK_SECRET'];
const RECOMMENDED = {
  cloudinary: ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'],
  email: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'],
  zumbopay: ['ZUMBOPAY_API_KEY', 'ZUMBOPAY_MERCHANT_ID']
};

const MIN_SECRET_LENGTH = 32;

const isSet = (env, key) => typeof env[key] === 'string' && env[key].trim() !== '';

/** Origens permitidas (CORS + Socket.IO), a partir de FRONTEND_URL (separadas por vírgula). */
const parseOrigins = (raw) =>
  String(raw || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);

const getAllowedOrigins = (env = process.env) => parseOrigins(env.FRONTEND_URL);

const isValidOrigin = (o) => {
  try {
    const u = new URL(o);
    return (u.protocol === 'http:' || u.protocol === 'https:') && o !== '*';
  } catch {
    return false;
  }
};

/**
 * Valida o ambiente. Não termina o processo nem escreve logs — devolve
 * `{ errors, warnings, isProduction }` para o chamador decidir.
 */
function validateEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  const missing = ALWAYS_REQUIRED.filter((k) => !isSet(env, k));
  if (missing.length) errors.push(`Variáveis obrigatórias em falta: ${missing.join(', ')}`);

  if (isProduction) {
    const missingProd = PRODUCTION_REQUIRED.filter((k) => !isSet(env, k));
    if (missingProd.length) errors.push(`Variáveis obrigatórias em produção em falta: ${missingProd.join(', ')}`);

    for (const k of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
      if (isSet(env, k) && env[k].length < MIN_SECRET_LENGTH) {
        errors.push(`${k} tem menos de ${MIN_SECRET_LENGTH} caracteres (inseguro em produção).`);
      }
    }
    if (isSet(env, 'JWT_ACCESS_SECRET') && env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      errors.push('JWT_ACCESS_SECRET e JWT_REFRESH_SECRET não podem ser iguais.');
    }

    if (isSet(env, 'FRONTEND_URL')) {
      const bad = parseOrigins(env.FRONTEND_URL).filter((o) => !isValidOrigin(o));
      if (bad.length) errors.push(`FRONTEND_URL contém origens inválidas (use https://dominio, sem "*"): ${bad.join(', ')}`);
    }

    if (isSet(env, 'DATABASE_URL') && !/^postgres(ql)?:\/\//.test(env.DATABASE_URL)) {
      errors.push('DATABASE_URL não parece uma ligação PostgreSQL (postgresql://...).');
    }
  }

  if (isSet(env, 'BCRYPT_ROUNDS')) {
    const r = parseInt(env.BCRYPT_ROUNDS, 10);
    if (!Number.isInteger(r) || r < 10 || r > 15) warnings.push('BCRYPT_ROUNDS deve estar entre 10 e 15 (a usar 12 por omissão).');
  }

  for (const [group, keys] of Object.entries(RECOMMENDED)) {
    const absent = keys.filter((k) => !isSet(env, k));
    if (absent.length) warnings.push(`Funcionalidade "${group}" degradada — faltam: ${absent.join(', ')}`);
  }

  return { errors, warnings, isProduction };
}

/**
 * Valida e, havendo erros, termina o processo com mensagem clara.
 * `exit` e `log` são injectáveis para testes.
 */
function assertEnv({ env = process.env, log = console, exit = (c) => process.exit(c) } = {}) {
  const { errors, warnings } = validateEnv(env);
  warnings.forEach((w) => log.warn(`⚠ [env] ${w}`));
  if (errors.length) {
    errors.forEach((e) => log.error(`❌ [env] ${e}`));
    log.error('Configure as variáveis a partir de .env.example antes de arrancar o servidor.');
    exit(1);
    return false;
  }
  return true;
}

module.exports = { validateEnv, assertEnv, getAllowedOrigins, parseOrigins, isValidOrigin, MIN_SECRET_LENGTH };
