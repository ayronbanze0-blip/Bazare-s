'use strict';

/**
 * Saúde de um produto — identifica problemas que prejudicam vendas e devolve dicas em português.
 * Lógica pura (sem BD) — testável com `node` puro.
 *
 * severity: high (impede/prejudica a venda), medium, low
 */

const MIN_DESCRIPTION = 20;

/**
 * @param {object} p  produto com { name, description, price, category, stock, active, images?: [] , _count?: { images } }
 * @returns {{code:string,severity:string,message:string,tip:string}[]}
 */
function assessProduct(p) {
  const issues = [];
  const imageCount = Array.isArray(p.images) ? p.images.length : (p._count && Number.isInteger(p._count.images) ? p._count.images : null);

  if (!p.active) {
    issues.push({ code: 'INACTIVE', severity: 'medium', message: 'Produto inativo.', tip: 'Ativa o produto para voltar a aparecer nas pesquisas.' });
  }
  if (!Number.isFinite(p.price) || p.price <= 0) {
    issues.push({ code: 'INVALID_PRICE', severity: 'high', message: 'Preço inválido.', tip: 'Define um preço maior que zero.' });
  }
  if (!Number.isInteger(p.stock) || p.stock <= 0) {
    issues.push({ code: 'OUT_OF_STOCK', severity: 'high', message: 'Sem stock.', tip: 'Atualiza o stock para poderes vender.' });
  }
  if (imageCount === 0) {
    issues.push({ code: 'NO_IMAGE', severity: 'high', message: 'Sem imagens.', tip: 'Adiciona mais imagens — produtos com fotos vendem muito mais.' });
  } else if (imageCount === 1) {
    issues.push({ code: 'FEW_IMAGES', severity: 'low', message: 'Só tem 1 imagem.', tip: 'Adiciona mais imagens de ângulos diferentes.' });
  }
  const desc = typeof p.description === 'string' ? p.description.trim() : '';
  if (desc.length === 0) {
    issues.push({ code: 'NO_DESCRIPTION', severity: 'medium', message: 'Sem descrição.', tip: 'Adiciona uma descrição.' });
  } else if (desc.length < MIN_DESCRIPTION) {
    issues.push({ code: 'SHORT_DESCRIPTION', severity: 'low', message: 'Descrição muito curta.', tip: 'Descreve melhor o produto (estado, medidas, entrega).' });
  }
  if (!p.category || String(p.category).trim() === '') {
    issues.push({ code: 'NO_CATEGORY', severity: 'medium', message: 'Sem categoria.', tip: 'Escolhe uma categoria para o produto ser encontrado.' });
  }
  return issues;
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

/** Resume uma lista de produtos: só os que têm problemas, do mais grave para o menos grave. */
function summarizeHealth(products) {
  const items = [];
  for (const p of products) {
    const issues = assessProduct(p);
    if (issues.length) {
      const worst = Math.min(...issues.map((i) => SEVERITY_ORDER[i.severity]));
      items.push({ id: p.id, name: p.name, stock: p.stock, active: p.active, issues, _rank: worst });
    }
  }
  items.sort((a, b) => a._rank - b._rank || b.issues.length - a.issues.length);
  return { items: items.map(({ _rank, ...rest }) => rest), checked: products.length, withIssues: items.length };
}

module.exports = { assessProduct, summarizeHealth, MIN_DESCRIPTION };
