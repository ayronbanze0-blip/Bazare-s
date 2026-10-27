'use strict';

// Limites de ficheiros por publicação — UM só sítio para backend e documentação.
// O frontend tem a mesma constante em cada ecrã (anuncio.html, newreels.html, historia.html…):
// se mudar aqui, mude lá também (procure "uploadLimits.js").
module.exports = {
  // Fotos por post (anúncio), reel de fotos, publicação de comunidade e slides de uma história.
  MAX_IMAGES_PER_POST: 20,
  // Cada história publica UMA foto por pedido (o ecrã envia os slides um a um), por isso este é o
  // limite de slides por publicação no ecrã e NÃO de ficheiros por pedido.
  MAX_STORY_SLIDES: 20,
  // Quantas histórias de um mesmo bazar a barra de histórias devolve (uma publicação de 20 slides
  // + uma segunda publicação no mesmo dia continuam todas visíveis).
  MAX_STORIES_PER_BAZAR_LIST: 40
};
