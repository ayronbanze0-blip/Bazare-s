'use strict';

/**
 * Mistura simples e explicável do feed: dentro da PÁGINA já decidida (mesmos itens, mesmo
 * cursor), evita que um único tipo de conteúdo (ex.: só reels) domine em sequência.
 *
 * Regra: mantém a ordem original (mais recente primeiro) e só "adia" um item se ele fosse o
 * (maxRun+1)-ésimo do mesmo tipo seguido — nesse caso passa à frente o próximo item de outro
 * tipo. Se não houver mais nenhum tipo diferente, o resto segue pela ordem original.
 * Nunca remove nem repete itens.
 */
function interleaveByType(items, { maxRun = 2, typeOf = (it) => it.targetType } = {}) {
  const remaining = items.slice();
  const out = [];
  let runType = null;
  let runLen = 0;

  while (remaining.length) {
    let idx = 0;
    if (runLen >= maxRun) {
      const other = remaining.findIndex((it) => typeOf(it) !== runType);
      if (other !== -1) idx = other; // senão: só resta o mesmo tipo — segue a ordem original
    }
    const [item] = remaining.splice(idx, 1);
    const t = typeOf(item);
    if (t === runType) runLen += 1; else { runType = t; runLen = 1; }
    out.push(item);
  }
  return out;
}

module.exports = { interleaveByType };
