'use strict';

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
const logger = require('../utils/logger');
const prisma = require('../config/database');

const assertType = (targetType) => VALID_TYPES.includes(targetType);

// Mapa targetType → modelo Prisma, para confirmar que o alvo de facto
// existe antes de gravar uma reação/partilha. Sem isto, qualquer
// utilizador autenticado podia criar reações apontando para um
// targetId inventado/inexistente (não há FK entre FeedReaction e
// Product/Announcement/Reel).
const TARGET_MODEL = { PRODUCT: 'product', ANNOUNCEMENT: 'announcement', REEL: 'reel' };
const findTarget = async (targetType, targetId) => {
  const model = TARGET_MODEL[targetType];
  if (!model) return null;
  return prisma[model].findUnique({ where: { id: targetId }, select: { id: true, bazarId: true } });
};
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
const encodeFeedCursor = (isoDate) => Buffer.from(JSON.stringify({ s: isoDate })).toString('base64');
const decodeFeedCursor = (raw) => {
  try {
    const obj = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'));
    const d = new Date(obj?.s);
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
};

const list = async (req, res) => {
  try {
    const { cursor: rawCursor, limit = 15 } = req.query;
    const take = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 50);
    const cursorDate = rawCursor ? decodeFeedCursor(rawCursor) : null;
    // Sobrebusca: o filtro de bloqueio acontece depois de buscar, por
    // isso pedimos uma margem a mais de cada fonte para não devolver
    // menos itens do que o pedido só por causa de contas bloqueadas.
    const FETCH = take + 20;

    const productWhere = { active: true, featuredUntil: { gt: new Date() } };
    if (cursorDate) productWhere.featuredUntil.lt = cursorDate;
    const announcementWhere = {};
    if (cursorDate) announcementWhere.createdAt = { lt: cursorDate };
    const reelWhere = { bazar: { active: true } };
    if (cursorDate) reelWhere.createdAt = { lt: cursorDate };

    // "Para si": produtos comuns (não têm de estar em destaque) das
    // lojas com que já mostraste mais interesse — só entra no feed
    // enquanto já houver algum histórico de afinidade; sem isso fica
    // vazio e o feed continua só com destaques + posts + reels, como
    // já era antes desta fase.
    let forYouBazarIds = [];
    if (req.user?.id) {
      const topAffinity = await prisma.userAffinity.findMany({
        where: { userId: req.user.id },
        orderBy: { score: 'desc' },
        take: 5,
        select: { bazarId: true }
      });
      forYouBazarIds = topAffinity.map(a => a.bazarId);
    }
    const forYouWhere = { active: true, bazarId: { in: forYouBazarIds } };
    if (cursorDate) forYouWhere.createdAt = { lt: cursorDate };

    const [featuredProducts, announcements, reels, forYouProducts] = await Promise.all([
      prisma.product.findMany({
        where: productWhere,
        orderBy: { featuredUntil: 'desc' },
        take: FETCH,
        include: {
          images: { orderBy: { order: 'asc' }, take: 1 },
          bazar: { select: { id: true, name: true, slug: true } },
          seller: { select: { id: true, name: true, avatarUrl: true, isPremium: true } }
        }
      }),
      prisma.announcement.findMany({
        where: announcementWhere,
        orderBy: { createdAt: 'desc' },
        take: FETCH,
        include: {
          images: { orderBy: { order: 'asc' } },
          bazar: { select: { id: true, name: true, slug: true } },
          seller: { select: { id: true, name: true, avatarUrl: true, isPremium: true } },
          mentions: { select: { mentionedUserId: true, mentionedUser: { select: { username: true } } } },
          product: { select: { id: true, name: true, slug: true, price: true } },
          poll: true
        }
      }),
      prisma.reel.findMany({
        where: reelWhere,
        orderBy: { createdAt: 'desc' },
        take: FETCH,
        include: {
          images: { orderBy: { order: 'asc' } },
          bazar: { select: { id: true, name: true, slug: true } },
          seller: { select: { id: true, name: true, avatarUrl: true, isPremium: true } },
          product: { select: { id: true, name: true, slug: true, price: true } }
        }
      }),
      forYouBazarIds.length ? prisma.product.findMany({
        where: forYouWhere,
        orderBy: { createdAt: 'desc' },
        take: FETCH,
        include: {
          images: { orderBy: { order: 'asc' }, take: 1 },
          bazar: { select: { id: true, name: true, slug: true } },
          seller: { select: { id: true, name: true, avatarUrl: true, isPremium: true } }
        }
      }) : Promise.resolve([])
    ]);

    // Um produto em destaque também pode calhar de ser de uma loja com
    // afinidade alta — não o mostra a dobrar.
    const featuredIds = new Set(featuredProducts.map(p => p.id));
    const forYouProductsDeduped = forYouProducts.filter(p => !featuredIds.has(p.id));

    // Se qualquer uma das fontes devolveu o máximo pedido, pode
    // haver mais dessa fonte para além do que já buscámos — usado só
    // para decidir "hasMore", não muda o que é mostrado agora.
    const sourceMayHaveMore = featuredProducts.length === FETCH || announcements.length === FETCH || reels.length === FETCH || forYouProducts.length === FETCH;
    // A data mais antiga vista nesta busca (mesmo que filtrada depois
    // por bloqueio) — serve de cursor de recurso se o filtro de
    // bloqueio esvaziar a página toda, para o scroll não ficar preso
    // sem conseguir avançar para além de um trecho todo bloqueado.
    const oldestSeen = [
      ...featuredProducts.map(p => p.featuredUntil),
      ...announcements.map(a => a.createdAt),
      ...reels.map(r => r.createdAt),
      ...forYouProductsDeduped.map(p => p.createdAt)
    ].reduce((min, d) => (!min || d < min ? d : min), null);

    let items = [
      ...featuredProducts.map((p) => ({
        targetType: 'PRODUCT', targetId: p.id, createdAt: p.featuredUntil,
        product: p
      })),
      ...announcements.map((a) => ({
        targetType: 'ANNOUNCEMENT', targetId: a.id, createdAt: a.createdAt,
        announcement: a
      })),
      ...reels.map((r) => ({
        targetType: 'REEL', targetId: r.id, createdAt: r.createdAt,
        reel: r
      })),
      ...forYouProductsDeduped.map((p) => ({
        targetType: 'PRODUCT', targetId: p.id, createdAt: p.createdAt,
        product: p, forYou: true
      }))
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Esconde conteúdo de quem bloqueaste (ou de quem te bloqueou) —
    // um bloqueio esconde nos dois sentidos, ver blockService.
    if (req.user?.id) {
      const hiddenIds = await blockSvc.getHiddenUserIds(req.user.id);
      if (hiddenIds.size) {
        items = items.filter(it => {
          const sellerId = it.product?.seller?.id || it.announcement?.seller?.id || it.reel?.sellerId;
          return !hiddenIds.has(sellerId);
        });
      }
    }

    const hasMore = items.length > take || sourceMayHaveMore;
    items = items.slice(0, take);
    // Cursor para o próximo pedido: normalmente a data do último item
    // mostrado; se o bloqueio filtrou tudo desta leva mas ainda há mais
    // para trás, usa a data mais antiga vista (mesmo filtrada) para o
    // próximo pedido continuar a avançar em vez de repetir a mesma leva.
    const lastDate = items.length ? items[items.length - 1].createdAt : (hasMore ? oldestSeen : null);
    const nextCursor = lastDate ? encodeFeedCursor(lastDate) : null;

    // Feed inteligente: reordena SÓ dentro desta página já decidida
    // (mesmos itens, cursor calculado acima já não muda) segundo a
    // afinidade do utilizador com o bazar de cada item — quem
    // reage/comenta/segue mais uma loja passa a vê-la mais cedo no
    // feed, sem mexer em quais itens entram em cada página.
    if (req.user?.id) {
      items = await affinitySvc.applyAffinityOrder(
        items, req.user.id, (it) => it.product?.bazarId || it.announcement?.bazarId || it.reel?.bazarId
      );
    }

    items = await attachEngagement(items, req.user?.id);

    // Sondagens vêm da query principal só com a linha do Poll em si
    // (sem opções/contagens) — completa isso aqui, só para os itens
    // que realmente têm uma (a maioria dos Posts não tem).
    items = await Promise.all(items.map(async (it) => {
      if (it.announcement?.poll) {
        return { ...it, announcement: { ...it.announcement, poll: await shapePoll(it.announcement.poll, req.user?.id) } };
      }
      return it;
    }));

    // Estado real do botão "Seguir" no cartão do feed — sem isto o
    // frontend nunca sabia se já seguias a loja (feedFollowBtnHtml
    // recebia sempre `following=false` fixo, mesmo já a seguires).
    // attachFollowState (feedEngagementService) espera `it.bazar`
    // directo, mas aqui o bazar vem dentro de it.product/it.announcement/it.reel
    // — por isso aplica-se manualmente em vez de reutilizar essa função.
    if (req.user?.id) {
      const bazarIds = [...new Set(items.map(it => (it.product?.bazar || it.announcement?.bazar || it.reel?.bazar)?.id).filter(Boolean))];
      if (bazarIds.length) {
        const follows = await prisma.follow.findMany({ where: { userId: req.user.id, bazarId: { in: bazarIds } }, select: { bazarId: true } });
        const followedSet = new Set(follows.map(f => f.bazarId));
        items = items.map(it => {
          const key = it.targetType === 'PRODUCT' ? 'product' : it.targetType === 'ANNOUNCEMENT' ? 'announcement' : 'reel';
          const content = it[key];
          if (!content?.bazar) return it;
          return { ...it, [key]: { ...content, bazar: { ...content.bazar, isFollowing: followedSet.has(content.bazar.id) } } };
        });
      }
    }

    return ok(res, { items, meta: { hasMore, nextCursor } });
  } catch (err) {
    logger.error(`[Feed.list] ${err.message}`);
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
      : await prisma.reel.findUnique({ where: { id: targetId }, select: { id: true, bazarId: true } });
    if (!exists) return notFound(res, 'Conteúdo não encontrado.');

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

const targetWhere = (targetType, targetId) => targetType === 'PRODUCT'
  ? { productId: targetId }
  : targetType === 'ANNOUNCEMENT'
  ? { announcementId: targetId }
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
      : await prisma.reel.findUnique({ where: { id: targetId }, select: { id: true, bazarId: true, bazar: { select: { sellerId: true, name: true } } } });
    if (!exists) return notFound(res, 'Conteúdo não encontrado.');

    let parentId = null;
    let parentAuthorId = null;
    if (req.body.parentId) {
      const parent = await prisma.comment.findUnique({ where: { id: req.body.parentId }, select: { id: true, parentId: true, userId: true, ...targetWhere(targetType, targetId) } });
      if (!parent) return notFound(res, 'Comentário original não encontrado.');
      parentId = parent.parentId || parent.id; // respostas a respostas viram irmãs, thread de 1 nível
      parentAuthorId = parent.userId;
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
      : `reels.html?reel=${targetId}`;
    if (parentAuthorId && parentAuthorId !== req.user.id) {
      notifSvc.commentReply(parentAuthorId, req.user.name, req.body.text, link).catch(() => {});
    } else if (!parentAuthorId) {
      const ownerId = exists.bazar?.sellerId;
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
        reel: { select: { sellerId: true } }
      }
    });
    // Já não existe (ex.: apagado por outro pedido entretanto, ou um
    // duplo toque em "Apagar" durante a janela de "Desfazer" de 5s da
    // app) — trata-se como sucesso, não como erro: o resultado que a
    // pessoa queria (o comentário desaparecido) já está garantido.
    if (!comment) return ok(res, {}, 'Comentário removido.');
    const ownerId = comment.product?.sellerId || comment.announcement?.sellerId || comment.reel?.sellerId;
    const canDelete = comment.userId === req.user.id || ownerId === req.user.id || req.user.role === 'ADMIN';
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

module.exports = { list, react, reactors, share, listComments, listReplies, createComment, updateComment, removeComment, likeComment, engagement };

