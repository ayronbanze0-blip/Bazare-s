'use strict';

// ─────────────────────────────────────────────────────────────────
// aiService — cliente partilhado para a Gemini API (Google AI Studio).
// Todas as funcionalidades de IA do Bazares passam por aqui, para
// termos um único ponto de configuração, tratamento de erro e limite
// de custo. Usa fetch nativo do Node 18+, sem dependência extra.
// ─────────────────────────────────────────────────────────────────

const logger = require('../utils/logger');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

if (!GEMINI_API_KEY) {
  logger.warn('⚠ GEMINI_API_KEY não definida — funcionalidades de IA vão ficar indisponíveis até configurar no Railway.');
}

// ─── Chamada base à Gemini API ────────────────────────────────────
// responseSchema (opcional): força a Gemini a devolver JSON estruturado
// conforme o schema, evitando parsing frágil de texto livre.
const callGemini = async ({ prompt, responseSchema = null, timeoutMs = 15000 }) => {
  if (!GEMINI_API_KEY) {
    return { ok: false, error: 'IA indisponível (chave não configurada).' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        ...(responseSchema && {
          responseMimeType: 'application/json',
          responseSchema
        })
      }
    };

    const res = await fetch(`${BASE_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      logger.error(`[aiService] Gemini ${res.status}: ${errText.slice(0, 300)}`);
      if (res.status === 429) return { ok: false, error: 'Limite de pedidos de IA atingido. Tenta daqui a pouco.', rateLimited: true };
      return { ok: false, error: 'Falha ao contactar o serviço de IA.' };
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return { ok: false, error: 'Resposta vazia da IA.' };

    return { ok: true, text };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      logger.error('[aiService] Timeout na chamada à Gemini.');
      return { ok: false, error: 'O serviço de IA demorou demasiado a responder.' };
    }
    logger.error(`[aiService] ${err.message}`);
    return { ok: false, error: 'Erro inesperado no serviço de IA.' };
  }
};

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    // fallback: tenta extrair o primeiro bloco {...} caso a IA tenha
    // adicionado texto à volta do JSON
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* ignore */ }
    }
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────
// 1. Geração de descrição de produto
// ─────────────────────────────────────────────────────────────────
const generateProductDescription = async ({ name, category, keywords, condition }) => {
  const prompt = `És um assistente que escreve anúncios de produtos para o Bazares, um marketplace moçambicano.
Escreve em português, tom claro e apelativo, adequado ao contexto moçambicano (preços em MT, expressões locais quando fizer sentido).

Produto: "${name}"
Categoria: "${category || 'não especificada'}"
Estado: "${condition || 'Novo'}"
Palavras-chave do vendedor: "${keywords || ''}"

Devolve APENAS um JSON com este formato exacto, sem texto antes ou depois:
{
  "description": "descrição de 2 a 4 frases, vendável e honesta, sem exagerar",
  "suggestedCategory": "uma categoria sugerida a partir do nome do produto",
  "suggestedTitle": "um título curto e chamativo (máx 60 caracteres)"
}`;

  const result = await callGemini({ prompt });
  if (!result.ok) return result;

  const parsed = parseJson(result.text);
  if (!parsed || !parsed.description) {
    return { ok: false, error: 'Não consegui gerar a descrição. Tenta reformular as palavras-chave.' };
  }

  return { ok: true, ...parsed };
};

// ─────────────────────────────────────────────────────────────────
// 2. Moderação de anúncios antes da publicação
// ─────────────────────────────────────────────────────────────────
const moderateProduct = async ({ name, description, category, price }) => {
  const prompt = `És um moderador de conteúdo para o Bazares, um marketplace moçambicano. Analisa este anúncio e decide se pode ser publicado.

Nome: "${name}"
Descrição: "${description}"
Categoria: "${category}"
Preço: ${price} MT

Sinaliza como problema:
- Produtos proibidos (armas, drogas, animais em perigo, produtos falsificados, medicamentos controlados, conteúdo sexual)
- Spam ou texto sem sentido / repetitivo
- Linguagem ofensiva, discriminatória ou obscena
- Preço claramente incoerente com o produto descrito (ex: 1 MT para um carro), o que sugere anúncio-isco

Devolve APENAS um JSON com este formato exacto:
{
  "blocked": true ou false,
  "reason": "explicação curta em português, só se blocked=true, senão string vazia",
  "flag": "PROHIBITED" ou "SPAM" ou "OFFENSIVE" ou "SUSPICIOUS_PRICE" ou "NONE"
}`;

  const result = await callGemini({ prompt });
  if (!result.ok) {
    // Falha aberta: se a IA estiver indisponível, não bloqueia o vendedor.
    // A moderação é uma camada extra, não a única linha de defesa.
    logger.warn(`[aiService.moderateProduct] IA indisponível, a permitir publicação sem moderação: ${result.error}`);
    return { ok: true, blocked: false, flag: 'NONE', reason: '', unavailable: true };
  }

  const parsed = parseJson(result.text);
  if (!parsed) return { ok: true, blocked: false, flag: 'NONE', reason: '', unavailable: true };

  return { ok: true, blocked: !!parsed.blocked, reason: parsed.reason || '', flag: parsed.flag || 'NONE' };
};

// ─────────────────────────────────────────────────────────────────
// 3. Pesquisa inteligente — interpreta linguagem natural em filtros
// ─────────────────────────────────────────────────────────────────
const interpretSearchQuery = async (query) => {
  const prompt = `Um comprador escreveu esta pesquisa numa loja online moçambicana: "${query}"

Extrai os filtros de pesquisa. Devolve APENAS um JSON com este formato exacto:
{
  "keywords": "palavras-chave principais para pesquisar no nome/descrição, sem preço nem categoria",
  "category": "categoria provável do produto, ou null se não for claro",
  "minPrice": número ou null,
  "maxPrice": número ou null
}
Preços mencionados estão em Meticais (MT). Se disser "até X", maxPrice=X. Se disser "entre X e Y", usa ambos.`;

  const result = await callGemini({ prompt });
  if (!result.ok) return { ok: false, error: result.error };

  const parsed = parseJson(result.text);
  if (!parsed) return { ok: false, error: 'Não consegui interpretar a pesquisa.' };

  return { ok: true, ...parsed };
};

// ─────────────────────────────────────────────────────────────────
// 4. BazarBot — assistente de suporte automático
// ─────────────────────────────────────────────────────────────────
const BAZARBOT_CONTEXT = `És o BazarBot, o assistente de suporte oficial do Bazares, um marketplace moçambicano multi-vendedor.
Respondes em português, de forma curta, simpática e directa.
Sabes que: os pagamentos passam pela Carteira do Bazares com M-Pesa e e-Mola; vendedores têm a sua própria "Bazar" (loja); entregas são combinadas entre comprador e vendedor ou por método definido no anúncio.
Se a pergunta for sobre um problema específico de uma encomenda ou pagamento que não consegues resolver sozinho, diz claramente que vais encaminhar para um humano da equipa Bazares.
Nunca inventes políticas, prazos ou valores que não tenhas a certeza — nesse caso, diz que vais confirmar com a equipa.`;

const bazarBotReply = async (userMessage, history = []) => {
  const historyText = history
    .slice(-6)
    .map(h => `${h.fromBot ? 'BazarBot' : 'Utilizador'}: ${h.text}`)
    .join('\n');

  const prompt = `${BAZARBOT_CONTEXT}

${historyText ? `Histórico recente:\n${historyText}\n` : ''}
Nova mensagem do utilizador: "${userMessage}"

Responde directamente, sem JSON, só o texto da resposta (máx 4 frases).`;

  const result = await callGemini({ prompt });
  if (!result.ok) {
    return { ok: false, text: 'Desculpa, não consegui processar isso agora. Um membro da equipa vai responder em breve.' };
  }
  return { ok: true, text: result.text.trim() };
};

// ─────────────────────────────────────────────────────────────────
// 5. Assistente de resposta para vendedores (sugestão de resposta)
// ─────────────────────────────────────────────────────────────────
const suggestSellerReply = async (buyerMessage, history = []) => {
  const historyText = history
    .slice(-6)
    .map(h => `${h.fromSeller ? 'Vendedor' : 'Comprador'}: ${h.text}`)
    .join('\n');

  const prompt = `És um assistente que ajuda um vendedor do Bazares (marketplace moçambicano) a responder rápido a um comprador.
${historyText ? `Histórico:\n${historyText}\n` : ''}
Última mensagem do comprador: "${buyerMessage}"

Sugere UMA resposta curta, educada e útil que o vendedor pode enviar tal como está ou editar. Responde só com o texto da sugestão, sem aspas, sem JSON.`;

  const result = await callGemini({ prompt });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, suggestion: result.text.trim() };
};

module.exports = {
  generateProductDescription,
  moderateProduct,
  interpretSearchQuery,
  bazarBotReply,
  suggestSellerReply
};
