'use strict';

const crypto = require('crypto');
const { ok, created, notFound, badRequest, forbidden, serverError, validationError } = require('../utils/response');
const { sanitize, paginate, paginateMeta } = require('../utils/helpers');
const { validationResult } = require('express-validator');
const { attachEngagement, VALID_TYPES } = require('../services/feedEngagementService');
const affinitySvc = require('../services/affinityService');
const { shapePoll } = require('../services/pollService');
const commentService = require('../services/commentService');
const notifSvc = require('../services/notificationService');
const mentionSvc = require('../services/mentionService');
const blockSvc = require('../services/blockService');
const { interleaveByType } = require('../utils/feedMix');
const communitySvc = require('../services/communityService');
const logger = require('../utils/logger');
const prisma = require('../config/database');

const { makeStage } = require('../utils/resilience');
const assertType = (targetType) => VALID_TYPES.includes(targetType);

// Resiliência do GET /feed: cada fonte/etapa OPCIONAL corre isolada (ver utils/resilience.js).
const stage = makeStage('Feed.list');

// Mapa targetType → modelo Prisma, para confirmar que o alvo de facto
// existe antes de gravar uma reação/partilha. Sem isto, qualquer
// utilizador autenticado podia criar reações apontando para um
// targetId inventado/inexistente (não há FK entre FeedReaction e
// Product/Announcement/Reel).
const TARGET_MODEL = { PRODUCT: 'product', ANNOUNCEMENT: 'announcement', REEL: 'reel', GROUP_POST: 'communityPost' };
// CommunityPost (targetType GROUP_POST) não tem bazarId (não pertence
// a uma loja) — por isso o select varia consoante o tipo, em vez de
// pedir sempre bazarId (isso rebentava com "Unknown field" no Prisma
// para este tipo).
const findTarget = async (targetType, targetId) => {
  const model = TARGET_MODEL[targetType];
  if (!model) return null;
  const select = targetType === 'GROUP_POST' ? { id: true, communityId: true } : { id: true, bazarId: true };
  return prisma[model].findUnique({ where: { id: targetId }, select });
};
// Dono (utilizador) do conteúdo — necessário para aplicar bloqueios no backend
// (reagir/comentar/partilhar conteúdo de quem te bloqueou, ou de quem bloqueaste).
const ownerIdOf = async (targetType, target) => {
  if (!target) return null;
  if (targetType === 'GROUP_POST') {
    if (target.authorId) return target.authorId;
    const post = await prisma.communityPost.findUnique({ where: { id: target.id }, select: { authorId: true } });
    return post?.authorId || null;
  }
  const sellerId = target.bazar?.sellerId;
  if (sellerId) return sellerId;
  if (!target.bazarId) return null;
  const bazar = await prisma.bazar.findUnique({ where: { id: target.bazarId }, select: { sellerId: true } });
  return bazar?.sellerId || null;
};
const isBlockedFromTarget = async (userId, targetType, target) => {
  const ownerId = await ownerIdOf(targetType, target);
  return !!ownerId && ownerId !== userId && blockSvc.isBlockedEither(userId, ownerId);
};
const BLOCKED_MSG = 'Não é possível interagir com este conteúdo.';

// Mantido por compatibilidade com o nome antigo — usa findTarget por
// baixo para não duplicar a query.
const targetExists = async (targetType, targetId) => !!(await findTarget(targetType, targetId));

// ─── GET /api/feed/:targetType/:targetId/engagement ──────────────
// Números de reação/partilha/comentários de UM item — usado fora do
// feed agregado (ex: página do produto), sem precisar de paginar o
// feed inteiro só para saber a contagem de um item.
const engagement = async (req, res) => {
  try {
    const { targetType, targetId } = req.params;
    if (!assertType(targetType)) return badRequest(res, 'Tipo inválido.');
    const [result] = await attachEngagement([{ targetType, targetId }], req.user?.id);
    const { targetType: _t, targetId: _id, ...stats } = result;
    return ok(res, stats);
  } catch (err) {
    logger.error(`[Feed.engagement] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET /api/feed — página Home ──────────────────────────────────
// v1: produtos em destaque (featuredUntil activo) + anúncios recentes,
// misturados por data. Numa v2 isto passa a incluir também produtos
// novos e anúncios de quem não se segue ainda (descoberta) — fica
// preparado para isso porque já devolve targetType/targetId genéricos.
//
// Paginação por cursor (não por page/skip): junta duas fontes com
// "data" diferente (featuredUntil dos produtos, createdAt dos
// anúncios), cada uma pedida de forma independente e limitada — nunca
// a tabela toda. Um scroll infinito com page/skip degradava-se com o
// crescimento do feed e saltava/duplicava itens sempre que um anúncio
// novo entrava a meio da sessão de alguém (o offset da página 2
// deixava de apontar para onde apontava quando a pessoa viu a página
// 1). Com cursor, cada pedido só pergunta "o que é mais antigo do que
// o último item que já vi" — inserções novas no topo não deslocam
// nada que já foi mostrado.
// ─── Feed "descoberta" (estilo Facebook) ─────────────────────────────
// Cada pedido de página 1 gera uma SEMENTE nova: a ordem é uma mistura de novidade, afinidade, quem
// segues e um toque de aleatoriedade (semente + utilizador) — por isso o feed de cada pessoa é
// diferente do de outra e muda de cada vez que abres. O que já viste (o frontend manda `seen`, os
// últimos 8 caracteres de cada id) fica para o fim da fila — "só novidades" primeiro; quando já viste
// tudo o feed recicla em vez de ficar vazio. As tuas publicações novas (< 30 min) vão sempre para o topo.
//
// Paginação: o cursor leva { sd: semente, off: posição, t0: instante do pedido 1 }. A ordem é
// determinística para uma mesma semente + t0 (só conta conteúdo criado até t0), por isso as páginas
// seguintes continuam a mesma lista sem repetir nem saltar itens.
//
// Eficiência: a "piscina" é lida só com colunas leves (id, data, loja, vendedor); os registos completos
// (imagens, loja com logótipo, sondagens…) só são lidos para os ~10 itens da página escolhida.
const POOL = { products: 150, posts: 100, reels: 100 };
const SEEN_PENALTY = 3;
const OWN_BOOST_MS = 30 * 60 * 1000;
const FRESH_HALF_H = 72;

const hash01 = (str) => crypto.createHash('md5').update(str).digest().readUInt32BE(0) / 4294967296;
const shortId = (id) => String(id).slice(-8);
const encodeFeedCursor = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const decodeFeedCursor = (raw) => {
  try {
    const o = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'));
    if (o && typeof o.sd === 'string' && Number.isInteger(o.off) && o.off >= 0 && !isNaN(new Date(o.t0).getTime())) return o;
  } catch { /* cursor antigo/inválido → trata como página 1 */ }
  return null;
};
const parseSeen = (raw) => {
  const out = new Set();
  String(raw || '').split(',').slice(0, 600).forEach((x) => { const t = x.trim(); if (/^[A-Za-z0-9_-]{8}$/.test(t)) out.add(t); });
  return out;
};

const list = async (req, res) => {
  try {
    const { cursor: rawCursor, limit = 15, scope = 'foryou' } = req.query;
    const take = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 50);
    const cur = rawCursor ? decodeFeedCursor(rawCursor) : null;
    const seed = cur ? cur.sd : crypto.randomBytes(4).toString('hex');
    const offset = cur ? cur.off : 0;
    const t0 = cur ? new Date(cur.t0) : new Date();
    const userId = req.user?.id || null;
    const seen = parseSeen(req.query.seen);

    // Nunca mostrar conteúdo de contas SUSPENSAS, de bazares inactivos nem produtos bloqueados pela
    // moderação. (Bloqueios entre utilizadores são aplicados mais abaixo.)
    const visibleOwner = { seller: { active: true }, bazar: { active: true } };

    // Lojas que segues (boost no ranking; filtro no separador "Seguindo").
    const followedIds = userId
      ? (await stage('seguidos', () => prisma.follow.findMany({ where: { userId }, select: { bazarId: true }, take: 500 }), [])).map((f) => f.bazarId)
      : [];
    const followedSet = new Set(followedIds);
    const onlyFollowing = scope === 'following';
    if (onlyFollowing && !followedIds.length) return ok(res, { items: [], meta: { hasMore: false, nextCursor: null } });
    const base = { ...visibleOwner, createdAt: { lte: t0 }, ...(onlyFollowing && { bazarId: { in: followedIds } }) };

    // Afinidade (0..1) por loja.
    const affRows = userId
      ? await stage('afinidade-top', () => prisma.userAffinity.findMany({ where: { userId }, orderBy: { score: 'desc' }, take: 40, select: { bazarId: true, score: true } }), [])
      : [];
    const maxAff = Math.max(1, ...affRows.map((r) => r.score));
    const affMap = new Map(affRows.map((r) => [r.bazarId, r.score / maxAff]));

    const light = { id: true, createdAt: true, bazarId: true, seller: { select: { id: true, isPremium: true } } };
    const sources = await Promise.allSettled([
      prisma.product.findMany({ where: { active: true, moderationStatus: 'APPROVED', ...base }, orderBy: { createdAt: 'desc' }, take: POOL.products, select: { ...light, featuredUntil: true } }),
      prisma.announcement.findMany({ where: base, orderBy: { createdAt: 'desc' }, take: POOL.posts, select: light }),
      prisma.reel.findMany({ where: base, orderBy: { createdAt: 'desc' }, take: POOL.reels, select: light })
    ]);
    const srcNames = ['produtos', 'posts', 'reels'];
    sources.forEach((r, k) => {
      if (r.status === 'rejected') logger.error(`[Feed.list] fonte "${srcNames[k]}" falhou (a continuar sem ela): ${r.reason && r.reason.code ? r.reason.code + ' · ' : ''}${r.reason && r.reason.message}`);
    });
    // Se TODAS as fontes falharam não há feed possível — aí sim é erro do servidor.
    if (sources.every((r) => r.status === 'rejected')) throw sources[0].reason;
    const [pRows, aRows, rRows] = sources.map((r) => (r.status === 'fulfilled' ? r.value : []));

    const now = Date.now();
    let pool = [
      ...pRows.map((r) => ({ type: 'PRODUCT', row: r, featured: !!r.featuredUntil && new Date(r.featuredUntil).getTime() > now })),
      ...aRows.map((r) => ({ type: 'ANNOUNCEMENT', row: r })),
      ...rRows.map((r) => ({ type: 'REEL', row: r }))
    ];

    // Esconde conteúdo de quem bloqueaste (ou de quem te bloqueou) — nos dois sentidos, ver blockService.
    if (userId) {
      const hiddenIds = await stage('bloqueios', () => blockSvc.getHiddenUserIds(userId), () => new Set());
      if (hiddenIds.size) pool = pool.filter((c) => !hiddenIds.has(c.row.seller?.id));
    }

    const ranked = pool.map((c) => {
      const { row } = c;
      const created = new Date(row.createdAt).getTime();
      const ageH = Math.max(0, (now - created) / 3.6e6);
      let sc = 0.9 * hash01(`${seed}:${userId || 'anon'}:${row.id}`)   // aleatoriedade (muda por sessão e por utilizador)
        + Math.exp(-ageH / FRESH_HALF_H)                               // novidade
        + 0.8 * (affMap.get(row.bazarId) || 0);                        // afinidade
      if (followedSet.has(row.bazarId)) sc += 0.35;
      if (c.featured) sc += 0.3;
      if (row.seller?.isPremium) sc += 0.1;
      if (userId && row.seller?.id === userId && now - created < OWN_BOOST_MS) sc += 100; // a tua publicação nova: topo
      if (seen.has(shortId(row.id))) sc -= SEEN_PENALTY;                 // já viste: fim da fila
      return { ...c, sc, created };
    }).sort((a, b) => (b.sc - a.sc) || (b.created - a.created));

    // Variedade: máx. 2 seguidos do mesmo tipo (só reordena, nunca remove).
    const ordered = interleaveByType(ranked, { maxRun: 2, typeOf: (c) => c.type });
    const pageSlice = ordered.slice(offset, offset + take);
    const hasMore = offset + take < ordered.length;
    const nextCursor = hasMore ? encodeFeedCursor({ sd: seed, off: offset + take, t0: t0.toISOString() }) : null;

    // Fase 2: registos completos só para a página escolhida.
    const idsOf = (t) => pageSlice.filter((c) => c.type === t).map((c) => c.row.id);
    const bazarSel = { select: { id: true, name: true, slug: true, logoUrl: true } };
    const sellerSel = { select: { id: true, name: true, avatarUrl: true, isPremium: true } };
    const pIds = idsOf('PRODUCT'), aIds = idsOf('ANNOUNCEMENT'), rIds = idsOf('REEL');
    const full = await Promise.allSettled([
      pIds.length ? prisma.product.findMany({ where: { id: { in: pIds } }, include: { images: { orderBy: { order: 'asc' }, take: 1 }, bazar: bazarSel, seller: sellerSel } }) : [],
      aIds.length ? prisma.announcement.findMany({ where: { id: { in: aIds } }, include: { images: { orderBy: { order: 'asc' } }, bazar: bazarSel, seller: sellerSel, mentions: { select: { mentionedUserId: true, mentionedUser: { select: { username: true } } } }, product: { select: { id: true, name: true, slug: true, price: true } }, poll: true } }) : [],
      rIds.length ? prisma.reel.findMany({ where: { id: { in: rIds } }, include: { images: { orderBy: { order: 'asc' } }, bazar: bazarSel, seller: sellerSel, product: { select: { id: true, name: true, slug: true, price: true } } } }) : []
    ]);
    full.forEach((r, k) => {
      if (r.status === 'rejected') logger.error(`[Feed.list] detalhe "${srcNames[k]}" falhou (a continuar sem ele): ${r.reason && r.reason.code ? r.reason.code + ' · ' : ''}${r.reason && r.reason.message}`);
    });
    if (pageSlice.length && full.every((r) => r.status === 'rejected')) throw full[0].reason;
    const [pFull, aFull, rFull] = full.map((r) => (r.status === 'fulfilled' ? r.value : []));
    const pm = new Map(pFull.map((x) => [x.id, x])), am = new Map(aFull.map((x) => [x.id, x])), rm = new Map(rFull.map((x) => [x.id, x]));

    let items = pageSlice.map((c) => {
      const id = c.row.id;
      if (c.type === 'PRODUCT') return pm.has(id) ? { targetType: 'PRODUCT', targetId: id, createdAt: pm.get(id).createdAt, product: pm.get(id) } : null;
      if (c.type === 'ANNOUNCEMENT') return am.has(id) ? { targetType: 'ANNOUNCEMENT', targetId: id, createdAt: am.get(id).createdAt, announcement: am.get(id) } : null;
      return rm.has(id) ? { targetType: 'REEL', targetId: id, createdAt: rm.get(id).createdAt, reel: rm.get(id) } : null;
    }).filter(Boolean);

    {
      const before = items;
      items = await stage('engagement', () => attachEngagement(items, userId),
        () => before.map((it) => ({ ...it, likeCount: 0, dislikeCount: 0, shareCount: 0, commentCount: 0, myReaction: 0 })));
    }

    // Sondagens vêm da query principal só com a linha do Poll em si (sem opções/contagens) — completa
    // isso aqui, só para os itens que realmente têm uma (a maioria dos Posts não tem).
    items = await Promise.all(items.map(async (it) => {
      if (it.announcement?.poll) {
        const poll = await stage('sondagem', () => shapePoll(it.announcement.poll, userId), null);
        return { ...it, announcement: { ...it.announcement, poll } };
      }
      return it;
    }));

    // Estado real do botão "Seguir" no cartão (já temos as lojas seguidas em memória).
    if (userId) {
      items = items.map((it) => {
        const key = it.targetType === 'PRODUCT' ? 'product' : it.targetType === 'ANNOUNCEMENT' ? 'announcement' : 'reel';
        const content = it[key];
        if (!content?.bazar) return it;
        return { ...it, [key]: { ...content, bazar: { ...content.bazar, isFollowing: followedSet.has(content.bazar.id) } } };
      });
    }

    return ok(res, { items, meta: { hasMore, nextCursor } });
  } catch (err) {
    logger.error(`[Feed.list] ${err.code ? err.code + ' · ' : ''}${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/feed/:targetType/:targetId/react ──────────────────
// body: { value } — 1 a 7 (ver REACTIONS no frontend: Adoro/Gosto/
// Riso/Uau/Triste/Ira/Coragem); enviar o mesmo valor outra vez remove
// a reação (toggle, como Facebook/Instagram). Antes só aceitava 1/-1
// (resquício do antigo like/dislike binário) e rejeitava com 400
// qualquer reação que não fosse "Adoro" — as outras 6 estavam todas
// partidas desde que o selector de reações foi lançado no frontend.
const react = async (req, res) => {
  try {
    const { targetType, targetId } = req.params;
    if (!assertType(targetType)) return badRequest(res, 'Tipo inválido.');
    const value = parseInt(req.body.value, 10);
    if (!Number.isInteger(value) || value < 1 || value > 7) return badRequest(res, 'value deve ser um número entre 1 e 7.');

    const target = await findTarget(targetType, targetId);
    if (!target) {
      return notFound(res, 'Conteúdo não encontrado.');
    }
    if (await isBlockedFromTarget(req.user.id, targetType, target)) return forbidden(res, BLOCKED_MSG);

    const existing = await prisma.feedReaction.findUnique({
      where: { userId_targetType_targetId: { userId: req.user.id, targetType, targetId } }
    });

    if (existing && existing.value === value) {
      try {
        await prisma.feedReaction.delete({ where: { id: existing.id } });
      } catch (err) {
        if (err.code !== 'P2025') throw err; // já tinha sido removida por um pedido concorrente
      }
    } else {
      // upsert em vez de create/update separados — dois cliques rápidos
      // (findUnique → null em ambos, ambos a tentar create) causavam
      // P2002 e um 500 ao cliente. upsert é atómico e idempotente.
      await prisma.feedReaction.upsert({
        where: { userId_targetType_targetId: { userId: req.user.id, targetType, targetId } },
        create: { userId: req.user.id, targetType, targetId, value },
        update: { value }
      });
      // Só reforça o feed inteligente ao ADICIONAR/trocar uma reação —
      // removê-la não pune, só deixa de reforçar mais.
      affinitySvc.bump(req.user.id, target.bazarId, 'REACT').catch(() => {});
    }

    // likeCount = todas as reações (qualquer uma das 7), não só value===1
    // — ver a mesma correção em feedEngagementService.attachEngagement.
    const likeCount = await prisma.feedReaction.count({ where: { targetType, targetId } });
    const myReaction = (existing && existing.value === value) ? 0 : value;

    return ok(res, { likeCount, myReaction });
  } catch (err) {
    logger.error(`[Feed.react] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET /api/feed/:targetType/:targetId/reactors ──────────────────
// Lista de quem reagiu, ao estilo Facebook — devolve as pessoas mais
// recentes a reagir e, em `counts`, quantas há de cada uma das 7
// reações (para os separadores "Todas/❤️/👍/…" no frontend). `value`
// opcional filtra a lista para um só tipo de reação (um separador).
const reactors = async (req, res) => {
  try {
    const { targetType, targetId } = req.params;
    if (!assertType(targetType)) return badRequest(res, 'Tipo inválido.');
    const value = req.query.value ? parseInt(req.query.value, 10) : null;
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 7)) return badRequest(res, 'value deve ser um número entre 1 e 7.');
    const { page = 1, limit = 30 } = req.query;
    const { skip, take } = paginate(page, limit);

    const where = { targetType, targetId, ...(value ? { value } : {}) };
    const [rows, total, grouped] = await Promise.all([
      prisma.feedReaction.findMany({
        where,
        include: { user: { select: { id: true, name: true, avatarUrl: true, isPremium: true } } },
        orderBy: { createdAt: 'desc' },
        skip, take
      }),
      prisma.feedReaction.count({ where }),
      prisma.feedReaction.groupBy({ by: ['value'], where: { targetType, targetId }, _count: { value: true } })
    ]);

    const counts = {};
    grouped.forEach(g => { counts[g.value] = g._count.value; });
    const reactorsList = rows.filter(r => r.user).map(r => ({ user: r.user, value: r.value }));

    return ok(res, { reactors: reactorsList, counts, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Feed.reactors] ${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/feed/:targetType/:targetId/share ──────────────────
// Repartilha dentro do próprio feed do Bazares — aparece também no
// feed de quem partilhou (marcado como "sharedByMe" na listagem).
const share = async (req, res) => {
  try {
    const { targetType, targetId } = req.params;
    if (!assertType(targetType)) return badRequest(res, 'Tipo inválido.');

    const exists = targetType === 'PRODUCT'
      ? await prisma.product.findUnique({ where: { id: targetId }, select: { id: true, bazarId: true } })
      : targetType === 'ANNOUNCEMENT'
      ? await prisma.announcement.findUnique({ where: { id: targetId }, select: { id: true, bazarId: true } })
      : targetType === 'GROUP_POST'
      ? await prisma.communityPost.findUnique({ where: { id: targetId }, select: { id: true, communityId: true } })
      : await prisma.reel.findUnique({ where: { id: targetId }, select: { id: true, bazarId: true } });
    if (!exists) return notFound(res, 'Conteúdo não encontrado.');
    if (await isBlockedFromTarget(req.user.id, targetType, exists)) return forbidden(res, BLOCKED_MSG);

    await prisma.feedShare.upsert({
      where: { userId_targetType_targetId: { userId: req.user.id, targetType, targetId } },
      update: {},
      create: { userId: req.user.id, targetType, targetId }
    });
    affinitySvc.bump(req.user.id, exists.bazarId, 'SHARE').catch(() => {});

    const shareCount = await prisma.feedShare.count({ where: { targetType, targetId } });
    return ok(res, { shared: true, shareCount }, 'Partilhado no teu feed.');
  } catch (err) {
    logger.error(`[Feed.share] ${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/feed/:targetType/:targetId/save ───────────────────
// Guardar/Favoritar genérico para qualquer tipo de conteúdo (Post,
// Reel, Post de comunidade) — para Product continua a valer
// product.isFavorite (Favorite), este endpoint é o que faltava para
// os outros tipos. Toggle: chamar de novo remove.
const toggleSave = async (req, res) => {
  try {
    const { targetType, targetId } = req.params;
    if (!assertType(targetType)) return badRequest(res, 'Tipo inválido.');

    const target = await findTarget(targetType, targetId);
    if (!target) return notFound(res, 'Conteúdo não encontrado.');
    if (await isBlockedFromTarget(req.user.id, targetType, target)) return forbidden(res, BLOCKED_MSG);

    const existing = await prisma.save.findUnique({
      where: { userId_targetType_targetId: { userId: req.user.id, targetType, targetId } }
    });

    let saved;
    if (existing) {
      try {
        await prisma.save.delete({ where: { id: existing.id } });
      } catch (err) {
        if (err.code !== 'P2025') throw err; // já removido por um pedido concorrente
      }
      saved = false;
    } else {
      await prisma.save.upsert({
        where: { userId_targetType_targetId: { userId: req.user.id, targetType, targetId } },
        update: {},
        create: { userId: req.user.id, targetType, targetId }
      });
      affinitySvc.bump(req.user.id, target.bazarId, 'SAVE').catch(() => {});
      saved = true;
    }

    return ok(res, { saved }, saved ? 'Guardado.' : 'Removido dos guardados.');
  } catch (err) {
    logger.error(`[Feed.toggleSave] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET /api/feed/saved ──────────────────────────────────────────
// Tudo o que o utilizador guardou (qualquer tipo), mais recente primeiro.
const mySaved = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);
    const where = { userId: req.user.id };
    const [rows, total] = await Promise.all([
      prisma.save.findMany({ where, take, skip, orderBy: { createdAt: 'desc' } }),
      prisma.save.count({ where })
    ]);
    const byType = { PRODUCT: [], ANNOUNCEMENT: [], REEL: [], GROUP_POST: [] };
    rows.forEach((r) => byType[r.targetType].push(r.targetId));
    const [products, announcements, reels, groupPosts] = await Promise.all([
      byType.PRODUCT.length ? prisma.product.findMany({ where: { id: { in: byType.PRODUCT } }, include: { images: { take: 1, orderBy: { order: 'asc' } } } }) : [],
      byType.ANNOUNCEMENT.length ? prisma.announcement.findMany({ where: { id: { in: byType.ANNOUNCEMENT } }, include: { images: { take: 1, orderBy: { order: 'asc' } } } }) : [],
      byType.REEL.length ? prisma.reel.findMany({ where: { id: { in: byType.REEL } }, include: { images: { take: 1, orderBy: { order: 'asc' } } } }) : [],
      byType.GROUP_POST.length ? prisma.communityPost.findMany({ where: { id: { in: byType.GROUP_POST } } }) : []
    ]);
    const byId = {};
    [...products, ...announcements, ...reels, ...groupPosts].forEach((it) => { byId[it.id] = it; });
    const items = rows.map((r) => ({ targetType: r.targetType, targetId: r.targetId, savedAt: r.createdAt, item: byId[r.targetId] || null }))
      .filter((it) => it.item);
    return ok(res, { items, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Feed.mySaved] ${err.message}`);
    return serverError(res);
  }
};

const targetWhere = (targetType, targetId) => targetType === 'PRODUCT'
  ? { productId: targetId }
  : targetType === 'ANNOUNCEMENT'
  ? { announcementId: targetId }
  : targetType === 'GROUP_POST'
  ? { communityPostId: targetId }
  : { reelId: targetId };

// ─── GET /api/feed/:targetType/:targetId/comments ────────────────
// Devolve comentários de topo com as respostas embutidas (até 3 por
// comentário) e likeCount/likedByMe de cada um — estilo Facebook.
const listComments = async (req, res) => {
  try {
    const { targetType, targetId } = req.params;
    if (!assertType(targetType)) return badRequest(res, 'Tipo inválido.');
    const { page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);
    const where = targetWhere(targetType, targetId);

    const { comments, total } = await commentService.listThreaded(where, req.user?.id, { take, skip });
    return ok(res, { comments, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Feed.listComments] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET /api/feed/comments/:commentId/replies ───────────────────
// Carregar o resto das respostas de um comentário ("ver mais N respostas").
const listReplies = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);
    const { replies, total } = await commentService.listReplies(req.params.commentId, req.user?.id, { take, skip });
    return ok(res, { replies, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Feed.listReplies] ${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/feed/:targetType/:targetId/comments ───────────────
// body: { text, parentId? } — parentId presente = é uma resposta a
// outro comentário (thread de 1 nível, como Facebook/Instagram).
const createComment = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return validationError(res, errors.array());

  try {
    const { targetType, targetId } = req.params;
    if (!assertType(targetType)) return badRequest(res, 'Tipo inválido.');

    const exists = targetType === 'PRODUCT'
      ? await prisma.product.findUnique({ where: { id: targetId }, select: { id: true, name: true, slug: true, bazarId: true, bazar: { select: { sellerId: true } } } })
      : targetType === 'ANNOUNCEMENT'
      ? await prisma.announcement.findUnique({ where: { id: targetId }, select: { id: true, bazarId: true, bazar: { select: { sellerId: true, name: true } } } })
      : targetType === 'GROUP_POST'
      ? await prisma.communityPost.findUnique({ where: { id: targetId }, select: { id: true, authorId: true, communityId: true, community: { select: { slug: true } } } })
      : await prisma.reel.findUnique({ where: { id: targetId }, select: { id: true, bazarId: true, bazar: { select: { sellerId: true, name: true } } } });
    if (!exists) return notFound(res, 'Conteúdo não encontrado.');
    if (await isBlockedFromTarget(req.user.id, targetType, exists)) return forbidden(res, BLOCKED_MSG);

    let parentId = null;
    let parentAuthorId = null;
    if (req.body.parentId) {
      const parent = await prisma.comment.findUnique({ where: { id: req.body.parentId }, select: { id: true, parentId: true, userId: true, ...targetWhere(targetType, targetId) } });
      if (!parent) return notFound(res, 'Comentário original não encontrado.');
      parentId = parent.parentId || parent.id; // respostas a respostas viram irmãs, thread de 1 nível
      parentAuthorId = parent.userId;
      // Também não se pode responder a um comentário de alguém com quem há bloqueio.
      if (parentAuthorId !== req.user.id && await blockSvc.isBlockedEither(req.user.id, parentAuthorId)) {
        return forbidden(res, BLOCKED_MSG);
      }
    }

    const comment = await prisma.comment.create({
      data: {
        userId: req.user.id,
        text: sanitize(req.body.text),
        parentId,
        ...targetWhere(targetType, targetId)
      },
      include: { user: { select: { id: true, name: true, avatarUrl: true, isPremium: true } } }
    });

    // Notificações — nunca bloqueiam a resposta nem se avisa a si mesmo.
    const link = targetType === 'PRODUCT' ? `product.html?id=${exists.slug || targetId}`
      : targetType === 'ANNOUNCEMENT' ? `home.html?announcement=${targetId}`
      : targetType === 'GROUP_POST' ? `comunidade.html?id=${exists.community?.slug || exists.communityId}`
      : `reels.html?reel=${targetId}`;
    if (parentAuthorId && parentAuthorId !== req.user.id) {
      notifSvc.commentReply(parentAuthorId, req.user.name, req.body.text, link).catch(() => {});
    } else if (!parentAuthorId) {
      const ownerId = targetType === 'GROUP_POST' ? exists.authorId : exists.bazar?.sellerId;
      if (ownerId && ownerId !== req.user.id) {
        notifSvc.commentOnContent(ownerId, req.user.name, req.body.text, link).catch(() => {});
      }
    }

    mentionSvc.syncMentions({
      text: comment.text,
      authorId: req.user.id,
      authorName: req.user.name,
      commentId: comment.id,
      link
    }).catch(() => {});
    affinitySvc.bump(req.user.id, exists.bazarId, 'COMMENT').catch(() => {});

    return created(res, { comment: { ...comment, likeCount: 0, likedByMe: false, replies: [] } }, 'Comentário publicado.');
  } catch (err) {
    logger.error(`[Feed.createComment] ${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/feed/comments/:commentId/like ─────────────────────
const likeComment = async (req, res) => {
  try {
    const comment = await prisma.comment.findUnique({ where: { id: req.params.commentId }, select: { id: true } });
    if (!comment) return notFound(res, 'Comentário não encontrado.');
    const result = await commentService.toggleLike(req.params.commentId, req.user.id);
    return ok(res, result);
  } catch (err) {
    logger.error(`[Feed.likeComment] ${err.message}`);
    return serverError(res);
  }
};

// ─── DELETE /api/feed/comments/:commentId ────────────────────────
// ─── PUT /api/feed/comments/:commentId — editar o próprio comentário ─
const updateComment = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return validationError(res, errors.array());

  try {
    const comment = await prisma.comment.findUnique({ where: { id: req.params.commentId } });
    if (!comment) return notFound(res, 'Comentário não encontrado.');
    if (comment.userId !== req.user.id) return forbidden(res, 'Só pode editar os seus próprios comentários.');

    const text = sanitize(req.body.text || '');
    if (!text) return badRequest(res, 'Escreva um comentário.');

    let updated;
    try {
      updated = await prisma.comment.update({
        where: { id: comment.id },
        data: { text, editedAt: new Date() },
        include: { user: { select: { id: true, name: true, avatarUrl: true } } }
      });
    } catch (updErr) {
      // Corrida rara: foi apagado (ex. pelo dono do post, a moderar)
      // entre o findUnique acima e este update.
      if (updErr.code === 'P2025') return notFound(res, 'Comentário não encontrado.');
      throw updErr;
    }

    const link = comment.productId ? `product.html?id=${comment.productId}`
      : comment.announcementId ? `home.html?announcement=${comment.announcementId}`
      : comment.communityPostId ? `comunidade.html?post=${comment.communityPostId}`
      : `reels.html?reel=${comment.reelId}`;

    mentionSvc.syncMentions({
      text,
      authorId: req.user.id,
      authorName: req.user.name,
      commentId: comment.id,
      link
    }).catch(() => {});

    return ok(res, { comment: updated }, 'Comentário actualizado.');
  } catch (err) {
    logger.error(`[Feed.updateComment] ${err.message}`);
    return serverError(res);
  }
};

const removeComment = async (req, res) => {
  try {
    const comment = await prisma.comment.findUnique({
      where: { id: req.params.commentId },
      include: {
        product: { select: { sellerId: true } },
        announcement: { select: { sellerId: true } },
        reel: { select: { sellerId: true } },
        communityPost: { select: { authorId: true, community: { select: { id: true, ownerId: true } } } }
      }
    });
    // Já não existe (ex.: apagado por outro pedido entretanto, ou um
    // duplo toque em "Apagar" durante a janela de "Desfazer" de 5s da
    // app) — trata-se como sucesso, não como erro: o resultado que a
    // pessoa queria (o comentário desaparecido) já está garantido.
    if (!comment) return ok(res, {}, 'Comentário removido.');
    const ownerId = comment.product?.sellerId || comment.announcement?.sellerId || comment.reel?.sellerId || comment.communityPost?.authorId;
    let canDelete = comment.userId === req.user.id || ownerId === req.user.id || req.user.role === 'ADMIN';
    // Num grupo, o dono/administrador/moderador também pode moderar
    // comentários de outras pessoas — não só o autor do post em si.
    if (!canDelete && comment.communityPost?.community) {
      canDelete = await communitySvc.isModOrAdmin(comment.communityPost.community, req.user.id);
    }
    if (!canDelete) return forbidden(res, 'Sem permissão para apagar este comentário.');

    try {
      await prisma.comment.delete({ where: { id: comment.id } });
    } catch (delErr) {
      // P2025 = "registo a apagar já não existe" — mesma corrida do
      // findUnique acima, só que entre a leitura e o delete. Idempotente:
      // o resultado desejado já está alcançado.
      if (delErr.code !== 'P2025') throw delErr;
    }
    return ok(res, {}, 'Comentário removido.');
  } catch (err) {
    logger.error(`[Feed.removeComment] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { list, react, reactors, share, toggleSave, mySaved, listComments, listReplies, createComment, updateComment, removeComment, likeComment, engagement };

