'use strict';

const prisma = require('../config/database');
const logger = require('../utils/logger');

// Domínio canónico do site (não da API) — é para lá que o sitemap deve
// apontar. Usa a primeira entrada de FRONTEND_URL (pode ter várias
// separadas por vírgula, ex: preview + produção).
function siteOrigin() {
  const first = (process.env.FRONTEND_URL || '').split(',')[0].trim();
  return first || 'https://bazares.pages.dev';
}

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── GET /sitemap.xml ────────────────────────────────────────────
// Lista produtos activos, bazares activos e categorias. Servido a
// partir do domínio do site (via proxy no _redirects do frontend),
// não do domínio da API.
const sitemap = async (req, res) => {
  try {
    const origin = siteOrigin();

    const [products, bazars, categories] = await Promise.all([
      prisma.product.findMany({
        where: { active: true },
        select: { slug: true, id: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 50000
      }),
      prisma.bazar.findMany({
        where: { active: true },
        select: { slug: true, updatedAt: true },
        take: 50000
      }),
      prisma.product.findMany({
        where: { active: true },
        select: { category: true },
        distinct: ['category']
      })
    ]);

    const urls = [];

    urls.push({ loc: `${origin}/`, priority: '1.0', changefreq: 'daily' });
    urls.push({ loc: `${origin}/products.html`, priority: '0.9', changefreq: 'daily' });
    urls.push({ loc: `${origin}/bazars.html`, priority: '0.8', changefreq: 'daily' });

    for (const c of categories) {
      if (!c.category) continue;
      urls.push({
        loc: `${origin}/categoria/${encodeURIComponent(c.category)}`,
        priority: '0.7',
        changefreq: 'daily'
      });
    }

    for (const b of bazars) {
      urls.push({
        loc: `${origin}/bazar/${encodeURIComponent(b.slug)}`,
        lastmod: b.updatedAt.toISOString(),
        priority: '0.7',
        changefreq: 'weekly'
      });
    }

    for (const p of products) {
      // Produtos sem slug ainda (antes do backfill correr) usam o id
      // como fallback, para nenhum produto ficar de fora do sitemap.
      const slugOrId = p.slug || p.id;
      urls.push({
        loc: `${origin}/produto/${encodeURIComponent(slugOrId)}`,
        lastmod: p.updatedAt.toISOString(),
        priority: '0.6',
        changefreq: 'weekly'
      });
    }

    const body =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls
        .map(
          (u) =>
            `  <url>\n    <loc>${xmlEscape(u.loc)}</loc>\n` +
            (u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : '') +
            `    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>\n`
        )
        .join('') +
      '</urlset>\n';

    res.set('Content-Type', 'application/xml');
    return res.send(body);
  } catch (err) {
    logger.error(`[SEO.sitemap] ${err.message}`);
    res.set('Content-Type', 'application/xml');
    return res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
  }
};

// ─── GET /robots.txt ─────────────────────────────────────────────
const robots = (req, res) => {
  const origin = siteOrigin();
  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /dashboard.html',
    'Disallow: /admin*',
    'Disallow: /wallet*',
    'Disallow: /finance.html',
    'Disallow: /checkout.html',
    'Disallow: /settings.html',
    'Disallow: /notifications.html',
    'Disallow: /chat.html',
    '',
    `Sitemap: ${origin}/sitemap.xml`
  ].join('\n');
  res.set('Content-Type', 'text/plain');
  return res.send(body);
};

module.exports = { sitemap, robots };
