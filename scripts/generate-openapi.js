'use strict';

/**
 * Gera docs/openapi.json (OpenAPI 3.0) a partir da auditoria estática de rotas.
 *   node scripts/generate-openapi.js          -> imprime o JSON
 *   node scripts/generate-openapi.js --write  -> escreve docs/openapi.json
 *
 * Documenta TODAS as rotas: método, caminho, parâmetros de caminho, autenticação (Bearer JWT),
 * role exigida e rate limiters. NÃO documenta ainda os schemas de pedido/resposta de cada endpoint
 * (isso exige anotar cada controller) — as respostas usam os envelopes reais da API:
 * { success, data, message } e { success:false, message, error:{code,message}, requestId }.
 * Nunca inclui segredos. Abre-se em qualquer visualizador OpenAPI (ex.: editor.swagger.io).
 */

const fs = require('fs');
const path = require('path');
const { auditRoutes } = require('./route-audit');

const pkg = require('../package.json');

const TAGS = {
  auth: 'Auth', users: 'Users', products: 'Products', orders: 'Orders', cart: 'Cart', chat: 'Chat',
  feed: 'Social', stories: 'Stories', reels: 'Reels', wallet: 'Wallet', premium: 'Premium', admin: 'Admin',
  reports: 'Reports', notifications: 'Notifications', bazars: 'Bazars', finance: 'Finance', seller: 'Seller',
  analytics: 'Analytics', search: 'Search', reviews: 'Reviews', ai: 'AI', media: 'Media', groups: 'Communities',
  polls: 'Polls', gamification: 'Gamification', revendedor: 'Revendedor'
};

const toOpenApiPath = (p) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const tagFor = (p) => {
  const seg = p.split('/')[2] || 'misc';
  return TAGS[seg] || seg;
};

function build(routes = auditRoutes()) {
  const paths = {};
  for (const r of routes) {
    const p = toOpenApiPath(r.path);
    const method = r.method.toLowerCase();
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    const params = [...r.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({
      name: m[1], in: 'path', required: true, schema: { type: 'string' }
    }));
    const responses = { 200: { description: 'Sucesso' } };
    if (r.auth === 'yes') responses[401] = { description: 'Não autenticado' };
    if (r.role !== 'any') responses[403] = { description: `Requer role: ${r.role}` };
    if (r.limiters.length) responses[429] = { description: `Limite de pedidos excedido (${r.limiters.join(', ')})` };

    paths[p] = paths[p] || {};
    paths[p][method] = {
      tags: [tagFor(r.path)],
      summary: `${r.method} ${r.path}`,
      description: `Auth: ${r.auth}. Role: ${r.role}.${r.limiters.length ? ` Rate limit: ${r.limiters.join(', ')}.` : ''}`,
      ...(params.length && { parameters: params }),
      ...(r.auth === 'yes' && { security: [{ bearerAuth: [] }] }),
      ...(r.auth === 'optional' && { security: [{}, { bearerAuth: [] }] }),
      'x-role': r.role,
      responses
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: 'Bazares API', version: pkg.version || '1.0.0', description: 'Gerado automaticamente por scripts/generate-openapi.js a partir das rotas. Sem schemas detalhados de pedido/resposta.' },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        Success: { type: 'object', properties: { success: { type: 'boolean', example: true }, message: { type: 'string' }, data: { type: 'object' } } },
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string' },
            error: { type: 'object', properties: { code: { type: 'string', example: 'FORBIDDEN' }, message: { type: 'string' } } },
            requestId: { type: 'string' }
          }
        }
      }
    },
    paths
  };
}

if (require.main === module) {
  const json = JSON.stringify(build(), null, 2) + '\n';
  if (process.argv.includes('--write')) {
    const out = path.join(__dirname, '..', 'docs', 'openapi.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
    console.log(`Escrito ${out}`);
  } else process.stdout.write(json);
}

module.exports = { build };
