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

function urlsetXml(urls) {
  return (
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
    '</urlset>\n'
  );
}

const EMPTY_URLSET = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>';

// Sitemaps individuais têm um limite rígido de 50.000 URLs (protocolo
// sitemaps.org) — usamos uma margem de segurança bem abaixo disso por
// ficheiro/chunk, e passamos a servir um sitemap-index.xml quando o
// total ultrapassa o que cabe num único ficheiro.
const CHUNK_SIZE = 20000;
const SINGLE_FILE_LIMIT = 45000;

// ─── GET /sitemap.xml ────────────────────────────────────────────
// Serve o sitemap único enquanto o total de URLs couber num só
// ficheiro; a partir daí passa a devolver um sitemap-index.xml que
// aponta para /sitemap-products-N.xml e /sitemap-bazars-N.xml.
const sitemap = async (req, res) => {
  try {
    const origin = siteOrigin();

    // Só produtos de bazares ACTIVOS — antes filtrava só product.active,
    // por isso um vendedor suspenso continuava indexado no Google.
    const activeProductWhere = { active: true, bazar: { active: true } };

    const [productCount, bazarCount] = await Promise.all([
      prisma.product.count({ where: activeProductWhere }),
      prisma.bazar.count({ where: { active: true } })
    ]);

    if (productCount + bazarCount > SINGLE_FILE_LIMIT) {
      const productPages = Math.ceil(productCount / CHUNK_SIZE) || 1;
      const bazarPages = Math.ceil(bazarCount / CHUNK_SIZE) || 1;

      const entries = [
        `  <sitemap><loc>${xmlEscape(`${origin}/sitemap-main.xml`)}</loc></sitemap>`,
        ...Array.from({ length: productPages }, (_, i) =>
          `  <sitemap><loc>${xmlEscape(`${origin}/sitemap-products-${i + 1}.xml`)}</loc></sitemap>`),
        ...Array.from({ length: bazarPages }, (_, i) =>
          `  <sitemap><loc>${xmlEscape(`${origin}/sitemap-bazars-${i + 1}.xml`)}</loc></sitemap>`)
      ];

      const body =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        entries.join('\n') + '\n' +
        '</sitemapindex>\n';

      res.set('Content-Type', 'application/xml');
      return res.send(body);
    }

    // Escala pequena — um único ficheiro chega, como antes.
    const [products, bazars, categories] = await Promise.all([
      prisma.product.findMany({
        where: activeProductWhere,
        select: { slug: true, id: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: SINGLE_FILE_LIMIT
      }),
      prisma.bazar.findMany({
        where: { active: true },
        select: { slug: true, updatedAt: true },
        take: SINGLE_FILE_LIMIT
      }),
      prisma.product.findMany({
        where: activeProductWhere,
        select: { category: true },
        distinct: ['category']
      })
    ]);

    const urls = buildStaticAndCategoryUrls(origin, categories)
      .concat(bazars.map(bazarToUrl(origin)))
      .concat(products.map(productToUrl(origin)));

    res.set('Content-Type', 'application/xml');
    return res.send(urlsetXml(urls));
  } catch (err) {
    logger.error(`[SEO.sitemap] ${err.message}`);
    res.set('Content-Type', 'application/xml');
    return res.status(500).send(EMPTY_URLSET);
  }
};

// ─── GET /sitemap-main.xml — páginas estáticas + categorias ───────
const sitemapMain = async (req, res) => {
  try {
    const origin = siteOrigin();
    const categories = await prisma.product.findMany({
      where: { active: true, bazar: { active: true } },
      select: { category: true },
      distinct: ['category']
    });
    res.set('Content-Type', 'application/xml');
    return res.send(urlsetXml(buildStaticAndCategoryUrls(origin, categories)));
  } catch (err) {
    logger.error(`[SEO.sitemapMain] ${err.message}`);
    res.set('Content-Type', 'application/xml');
    return res.status(500).send(EMPTY_URLSET);
  }
};

// ─── GET /sitemap-products-:page.xml ──────────────────────────────
const sitemapProducts = async (req, res) => {
  try {
    const origin = siteOrigin();
    const page = Math.max(1, parseInt(req.params.page, 10) || 1);
    const products = await prisma.product.findMany({
      where: { active: true, bazar: { active: true } },
      select: { slug: true, id: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * CHUNK_SIZE,
      take: CHUNK_SIZE
    });
    res.set('Content-Type', 'application/xml');
    return res.send(urlsetXml(products.map(productToUrl(origin))));
  } catch (err) {
    logger.error(`[SEO.sitemapProducts] ${err.message}`);
    res.set('Content-Type', 'application/xml');
    return res.status(500).send(EMPTY_URLSET);
  }
};

// ─── GET /sitemap-bazars-:page.xml ────────────────────────────────
const sitemapBazars = async (req, res) => {
  try {
    const origin = siteOrigin();
    const page = Math.max(1, parseInt(req.params.page, 10) || 1);
    const bazars = await prisma.bazar.findMany({
      where: { active: true },
      select: { slug: true, updatedAt: true },
      skip: (page - 1) * CHUNK_SIZE,
      take: CHUNK_SIZE
    });
    res.set('Content-Type', 'application/xml');
    return res.send(urlsetXml(bazars.map(bazarToUrl(origin))));
  } catch (err) {
    logger.error(`[SEO.sitemapBazars] ${err.message}`);
    res.set('Content-Type', 'application/xml');
    return res.status(500).send(EMPTY_URLSET);
  }
};

function buildStaticAndCategoryUrls(origin, categories) {
  const urls = [
    { loc: `${origin}/`, priority: '1.0', changefreq: 'daily' },
    { loc: `${origin}/products.html`, priority: '0.9', changefreq: 'daily' },
    { loc: `${origin}/bazars.html`, priority: '0.8', changefreq: 'daily' }
  ];
  for (const c of categories) {
    if (!c.category) continue;
    urls.push({
      loc: `${origin}/categoria/${encodeURIComponent(c.category)}`,
      priority: '0.7',
      changefreq: 'daily'
    });
  }
  return urls;
}

const bazarToUrl = (origin) => (b) => ({
  loc: `${origin}/bazar/${encodeURIComponent(b.slug)}`,
  lastmod: b.updatedAt.toISOString(),
  priority: '0.7',
  changefreq: 'weekly'
});

const productToUrl = (origin) => (p) => {
  // Produtos sem slug ainda (antes do backfill correr) usam o id
  // como fallback, para nenhum produto ficar de fora do sitemap.
  const slugOrId = p.slug || p.id;
  return {
    loc: `${origin}/produto/${encodeURIComponent(slugOrId)}`,
    lastmod: p.updatedAt.toISOString(),
    priority: '0.6',
    changefreq: 'weekly'
  };
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

module.exports = { sitemap, sitemapMain, sitemapProducts, sitemapBazars, robots };
