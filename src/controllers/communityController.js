'use strict';

const { ok, created, notFound, badRequest, forbidden, serverError } = require('../utils/response');
const { sanitize, paginate, paginateMeta, uniqueSlug } = require('../utils/helpers');
const uploadSvc = require('../services/uploadService');
const mentionSvc = require('../services/mentionService');
const blockSvc = require('../services/blockService');
const communitySvc = require('../services/communityService');
const { attachDirectEngagement } = require('../services/feedEngagementService');
const logger = require('../utils/logger');
const prisma = require('../config/database');

// ─────────────────────────────────────────────────────────────────
// Nota de contrato: este controller expõe /groups/* para bater certo
// com o frontend comunidade.html/comunidades.html/nova-comunidade.html
// (construído em paralelo, fora desta conversa — ver comentário no
// schema.prisma). Esse frontend não tem UI de pedidos de adesão
// pendentes nem de moderadores — só "dono" (ownerId) vs "membro" — por
// isso o fluxo aqui foi mantido simples de propósito: entrar é sempre
// imediato (público ou privado), e PRIVATE só significa "não aparece
// em Descobrir", não "precisa de aprovação". Os campos role
// ADMIN/MODERATOR em CommunityMember ficam disponíveis para uma
// futura UI de moderação, sem quebrar nada do que já existe.
// ─────────────────────────────────────────────────────────────────

const resolveCommunity = (idOrSlug) =>
  prisma.community.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] } });

const communityInclude = { owner: { select: { id: true, name: true, avatarUrl: true } } };

// ─────────────────────────────────────────────────────────────────
// GRUPOS — CRUD e listagem
// ─────────────────────────────────────────────────────────────────

// ─── PUBLIC: Listar/descobrir grupos (?q=&category=&mine=1&limit=) ──
const list = async (req, res) => {
  try {
    const { q = '', category = '', page = 1, limit = 20 } = req.query;
    // O frontend manda mine=1 (número), não mine=true — aceitar as
    // duas formas evita um bug bobo de comparação de string.
    const mine = req.query.mine === '1' || req.query.mine === 1 || req.query.mine === 'true';
    const { take, skip } = paginate(page, limit);

    const where = {};
    if (q.trim()) {
      where.OR = [
        { name: { contains: q.trim(), mode: 'insensitive' } },
        { description: { contains: q.trim(), mode: 'insensitive' } }
      ];
    }
    if (category) where.category = category;

    if (mine) {
      if (!req.user?.id) return ok(res, { groups: [], meta: paginateMeta(0, page, limit) });
      where.members = { some: { userId: req.user.id } };
    } else {
      // "Descobrir" nunca lista grupos PRIVATE — só aparecem em "As
      // minhas" (para quem já é membro) ou por acesso directo ao link.
      where.privacy = 'PUBLIC';
    }

    const [communities, total] = await Promise.all([
      prisma.community.findMany({ where, take, skip, orderBy: { createdAt: 'desc' }, include: communityInclude }),
      prisma.community.count({ where })
    ]);

    return ok(res, {
      groups: await communitySvc.shapeCommunities(communities, req.user?.id),
      meta: paginateMeta(total, page, limit)
    });
  } catch (err) {
    logger.error(`[Groups.list] ${err.message}`);
    return serverError(res);
  }
};

// ─── PUBLIC: Ver um grupo (por id ou slug — acessível mesmo privado,
// "só quem tem a ligação vê o conteúdo") ────────────────────────────
const getOne = async (req, res) => {
  try {
    const community = await prisma.community.findFirst({
      where: { OR: [{ id: req.params.idOrSlug }, { slug: req.params.idOrSlug }] },
      include: communityInclude
    });
    if (!community) return notFound(res, 'Comunidade não encontrada.');
    return ok(res, { group: await communitySvc.shapeCommunity(community, req.user?.id) });
  } catch (err) {
    logger.error(`[Groups.getOne] ${err.message}`);
    return serverError(res);
  }
};

// ─── AUTH: Criar um grupo — qualquer utilizador (não precisa ser
// vendedor: comunidades são de interesse geral, não de loja). O
// criador entra logo como membro (role ADMIN) e fica registado como
// dono em Community.ownerId. ───────────────────────────────────────
const create = async (req, res) => {
  try {
    const name = sanitize(req.body.name || '');
    if (!name || name.length < 3) return badRequest(res, 'O nome da comunidade deve ter pelo menos 3 caracteres.');
    if (name.length > 60) return badRequest(res, 'Máximo de 60 caracteres no nome.');

    const description = req.body.description ? sanitize(req.body.description).slice(0, 500) : null;
    const category = req.body.category ? sanitize(req.body.category).slice(0, 60) : null;
    const privacy = req.body.privacy === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC';

    const slug = await uniqueSlug(prisma, name, 'community');

    let coverUrl = null, coverPublicId = null;
    if (req.file) {
      const r = await uploadSvc.uploadToCloud(req.file.path, 'bazares/communities/covers');
      if (r.ok) { coverUrl = r.url; coverPublicId = r.publicId; }
    }

    const community = await prisma.community.create({
      data: {
        name, slug, description, category, privacy, coverUrl, coverPublicId,
        ownerId: req.user.id,
        members: { create: { userId: req.user.id, role: 'ADMIN' } }
      },
      include: communityInclude
    });

    return created(res, { group: await communitySvc.shapeCommunity(community, req.user.id) }, 'Comunidade criada.');
  } catch (err) {
    logger.error(`[Groups.create] ${err.message}`);
    return serverError(res);
  }
};

// ─── DONO/ADMIN do grupo: editar dados (endpoint pronto — o botão
// "Editar" no frontend actual ainda só mostra um aviso "em breve",
// mas a rota já fica disponível para quando isso for ligado). ───────
const update = async (req, res) => {
  try {
    const community = await resolveCommunity(req.params.idOrSlug);
    if (!community) return notFound(res, 'Comunidade não encontrada.');
    if (!(await communitySvc.isAdmin(community, req.user.id)) && req.user.role !== 'ADMIN') {
      return forbidden(res, 'Só o dono ou administradores da comunidade podem editar.');
    }

    const data = {};
    if (req.body.name !== undefined) {
      const name = sanitize(req.body.name || '');
      if (!name || name.length < 3) return badRequest(res, 'O nome da comunidade deve ter pelo menos 3 caracteres.');
      data.name = name.slice(0, 60);
    }
    if (req.body.description !== undefined) data.description = req.body.description ? sanitize(req.body.description).slice(0, 500) : null;
    if (req.body.category !== undefined) data.category = req.body.category ? sanitize(req.body.category).slice(0, 60) : null;
    if (req.body.privacy !== undefined) data.privacy = req.body.privacy === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC';

    if (req.file) {
      const r = await uploadSvc.uploadToCloud(req.file.path, 'bazares/communities/covers');
      if (r.ok) {
        if (community.coverPublicId) uploadSvc.deleteFromCloud(community.coverPublicId).catch(() => {});
        data.coverUrl = r.url; data.coverPublicId = r.publicId;
      }
    }

    const updated = await prisma.community.update({ where: { id: community.id }, data, include: communityInclude });
    return ok(res, { group: await communitySvc.shapeCommunity(updated, req.user.id) }, 'Comunidade actualizada.');
  } catch (err) {
    logger.error(`[Groups.update] ${err.message}`);
    return serverError(res);
  }
};

// ─── DONO (ou admin da plataforma): apagar a comunidade ────────────
const remove = async (req, res) => {
  try {
    const community = await resolveCommunity(req.params.idOrSlug);
    if (!community) return notFound(res, 'Comunidade não encontrada.');
    if (!(await communitySvc.isAdmin(community, req.user.id)) && req.user.role !== 'ADMIN') {
      return forbidden(res, 'Só o dono da comunidade pode apagá-la.');
    }

    if (community.coverPublicId) uploadSvc.deleteFromCloud(community.coverPublicId).catch(() => {});
    const images = await prisma.communityPostImage.findMany({
      where: { communityPost: { communityId: community.id } },
      select: { publicId: true }
    });
    images.forEach((img) => { if (img.publicId) uploadSvc.deleteFromCloud(img.publicId).catch(() => {}); });

    await prisma.community.delete({ where: { id: community.id } });
    return ok(res, {}, 'Comunidade removida.');
  } catch (err) {
    logger.error(`[Groups.remove] ${err.message}`);
    return serverError(res);
  }
};

// ─────────────────────────────────────────────────────────────────
// ADESÃO — entrar/sair, membros, papéis
// ─────────────────────────────────────────────────────────────────

// ─── AUTH: Entrar num grupo — sempre imediato (público ou privado;
// ver nota de âmbito no topo do ficheiro). ─────────────────────────
const join = async (req, res) => {
  try {
    const community = await resolveCommunity(req.params.idOrSlug);
    if (!community) return notFound(res, 'Comunidade não encontrada.');

    if (await blockSvc.isBlockedEither(req.user.id, community.ownerId)) {
      return forbidden(res, 'Não é possível entrar nesta comunidade.');
    }

    const existing = await communitySvc.getMembership(community.id, req.user.id);
    if (existing) return ok(res, {}, 'Já é membro desta comunidade.');

    await prisma.communityMember.create({ data: { communityId: community.id, userId: req.user.id, role: 'MEMBER' } });
    return created(res, {}, 'Entraste na comunidade.');
  } catch (err) {
    logger.error(`[Groups.join] ${err.message}`);
    return serverError(res);
  }
};

// ─── AUTH: Sair de um grupo — o dono não pode sair (teria de apagar
// a comunidade ou, no futuro, transferir a posse primeiro). ─────────
const leave = async (req, res) => {
  try {
    const community = await resolveCommunity(req.params.idOrSlug);
    if (!community) return notFound(res, 'Comunidade não encontrada.');

    if (community.ownerId === req.user.id) {
      return badRequest(res, 'É a(o) dona(o) desta comunidade — apague-a em vez de sair.');
    }

    const membership = await communitySvc.getMembership(community.id, req.user.id);
    if (!membership) return ok(res, {}, 'Já não é membro desta comunidade.');

    await prisma.communityMember.delete({ where: { id: membership.id } });
    return ok(res, {}, 'Saiu da comunidade.');
  } catch (err) {
    logger.error(`[Groups.leave] ${err.message}`);
    return serverError(res);
  }
};

// ─── PUBLIC: listar membros (achatado — {id,name,avatarUrl,...} —
// mesma forma que o frontend já espera de userPhoto()/m.id). ───────
const listMembers = async (req, res) => {
  try {
    const community = await resolveCommunity(req.params.idOrSlug);
    if (!community) return notFound(res, 'Comunidade não encontrada.');

    const { page = 1, limit = 30 } = req.query;
    const { take, skip } = paginate(page, limit);

    const [members, total] = await Promise.all([
      prisma.communityMember.findMany({
        where: { communityId: community.id },
        include: { user: { select: { id: true, name: true, avatarUrl: true, isPremium: true } } },
        orderBy: { joinedAt: 'asc' },
        take, skip
      }),
      prisma.communityMember.count({ where: { communityId: community.id } })
    ]);

    const flattened = members.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      avatarUrl: m.user.avatarUrl,
      isPremium: m.user.isPremium,
      role: m.role,
      joinedAt: m.joinedAt
    }));

    return ok(res, { members: flattened, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Groups.listMembers] ${err.message}`);
    return serverError(res);
  }
};

// ─── DONO/ADMIN: remover um membro (nunca o próprio dono) ──────────
const removeMember = async (req, res) => {
  try {
    const community = await resolveCommunity(req.params.idOrSlug);
    if (!community) return notFound(res, 'Comunidade não encontrada.');
    if (!(await communitySvc.isAdmin(community, req.user.id)) && req.user.role !== 'ADMIN') {
      return forbidden(res, 'Só o dono ou administradores da comunidade podem remover membros.');
    }
    if (req.params.userId === community.ownerId) {
      return badRequest(res, 'Não é possível remover a(o) dona(o) da comunidade.');
    }

    const member = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: community.id, userId: req.params.userId } }
    });
    if (!member) return ok(res, {}, 'Já não é membro desta comunidade.');

    await prisma.communityMember.delete({ where: { id: member.id } });
    return ok(res, {}, 'Membro removido da comunidade.');
  } catch (err) {
    logger.error(`[Groups.removeMember] ${err.message}`);
    return serverError(res);
  }
};

// ─── DONO/ADMIN: promover/despromover um membro (bónus — sem UI
// própria ainda no frontend actual, só "dono vs membro"). ──────────
const updateMemberRole = async (req, res) => {
  try {
    const community = await resolveCommunity(req.params.idOrSlug);
    if (!community) return notFound(res, 'Comunidade não encontrada.');
    if (!(await communitySvc.isAdmin(community, req.user.id)) && req.user.role !== 'ADMIN') {
      return forbidden(res, 'Só o dono ou administradores da comunidade podem alterar papéis.');
    }

    const role = req.body.role;
    if (!['MEMBER', 'MODERATOR', 'ADMIN'].includes(role)) return badRequest(res, 'Papel inválido.');
    if (req.params.userId === community.ownerId) return badRequest(res, 'A(o) dona(o) da comunidade é sempre administradora(or).');

    const member = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: community.id, userId: req.params.userId } }
    });
    if (!member) return notFound(res, 'Membro não encontrado.');

    await prisma.communityMember.update({ where: { id: member.id }, data: { role } });
    return ok(res, {}, 'Papel actualizado.');
  } catch (err) {
    logger.error(`[Groups.updateMemberRole] ${err.message}`);
    return serverError(res);
  }
};

// ─────────────────────────────────────────────────────────────────
// POSTS DO GRUPO
// ─────────────────────────────────────────────────────────────────

const postInclude = {
  images: { orderBy: { order: 'asc' } },
  author: { select: { id: true, name: true, avatarUrl: true, isPremium: true } },
  mentions: { select: { mentionedUserId: true, mentionedUser: { select: { username: true } } } }
};

// ─── PUBLIC: listar posts (sem gate de privacidade — ver nota de
// âmbito no topo: PRIVATE só afecta a descoberta em /groups). ──────
const listPosts = async (req, res) => {
  try {
    const community = await resolveCommunity(req.params.idOrSlug);
    if (!community) return notFound(res, 'Comunidade não encontrada.');

    const { page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);

    let [posts, total] = await Promise.all([
      prisma.communityPost.findMany({
        where: { communityId: community.id },
        take, skip,
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
        include: postInclude
      }),
      prisma.communityPost.count({ where: { communityId: community.id } })
    ]);

    if (req.user?.id) {
      const hiddenIds = await blockSvc.getHiddenUserIds(req.user.id);
      if (hiddenIds.size) posts = posts.filter((p) => !hiddenIds.has(p.authorId));
    }

    const withEngagement = await attachDirectEngagement(posts, req.user?.id, 'GROUP_POST');
    return ok(res, { posts: withEngagement, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Groups.listPosts] ${err.message}`);
    return serverError(res);
  }
};

const getPost = async (req, res) => {
  try {
    const community = await resolveCommunity(req.params.idOrSlug);
    if (!community) return notFound(res, 'Comunidade não encontrada.');

    const post = await prisma.communityPost.findFirst({
      where: { id: req.params.postId, communityId: community.id },
      include: postInclude
    });
    if (!post) return notFound(res, 'Publicação não encontrada.');

    const [withEngagement] = await attachDirectEngagement([post], req.user?.id, 'GROUP_POST');
    return ok(res, { post: withEngagement });
  } catch (err) {
    logger.error(`[Groups.getPost] ${err.message}`);
    return serverError(res);
  }
};

// ─── MEMBRO: publicar no grupo (texto e/ou até 6 fotos) ────────────
const createPost = async (req, res) => {
  try {
    const community = await resolveCommunity(req.params.idOrSlug);
    if (!community) return notFound(res, 'Comunidade não encontrada.');
    if (!(await communitySvc.isMember(community.id, req.user.id))) {
      return forbidden(res, 'Só membros da comunidade podem publicar.');
    }

    const text = sanitize(req.body.text || '');
    const hasImages = !!(req.files && req.files.length > 0);
    if (!text && !hasImages) return badRequest(res, 'Escreva algo ou junte uma foto para publicar.');
    if (text.length > 2000) return badRequest(res, 'Máximo de 2000 caracteres.');

    let backgroundId = null;
    if (req.body.backgroundId && !hasImages) {
      const n = parseInt(req.body.backgroundId, 10);
      if (n >= 1 && n <= 8) backgroundId = n;
    }

    const post = await prisma.communityPost.create({
      data: { communityId: community.id, authorId: req.user.id, text, backgroundId }
    });

    let imageUploadErrors = [];
    if (hasImages) {
      const uploadResults = await uploadSvc.uploadMany(req.files, 'bazares/communities/posts');
      const validImages = uploadResults.filter((r) => r.ok);
      imageUploadErrors = uploadResults.filter((r) => !r.ok).map((r) => r.error);
      if (validImages.length > 0) {
        await prisma.communityPostImage.createMany({
          data: validImages.map((r, i) => ({ communityPostId: post.id, url: r.url, publicId: r.publicId, order: i }))
        });
      }
    }

    const full = await prisma.communityPost.findUnique({ where: { id: post.id }, include: postInclude });

    mentionSvc.syncMentions({
      text,
      authorId: req.user.id,
      authorName: req.user.name,
      communityPostId: post.id,
      link: `comunidade.html?id=${community.slug || community.id}`
    }).catch(() => {});

    return created(
      res,
      { post: { ...full, likeCount: 0, dislikeCount: 0, shareCount: 0, commentCount: 0, myReaction: 0 }, imageUploadErrors: imageUploadErrors.length ? imageUploadErrors : undefined },
      'Publicado na comunidade.'
    );
  } catch (err) {
    logger.error(`[Groups.createPost] ${err.message}`);
    return serverError(res);
  }
};

// ─── AUTOR: editar o próprio post (texto + fundo — sem UI própria
// ainda no frontend actual, endpoint pronto). ───────────────────────
const updatePost = async (req, res) => {
  try {
    const post = await prisma.communityPost.findUnique({ where: { id: req.params.postId } });
    if (!post) return notFound(res, 'Publicação não encontrada.');
    if (post.authorId !== req.user.id) return forbidden(res, 'Só o autor pode editar esta publicação.');

    const text = sanitize(req.body.text || '');
    if (!text) return badRequest(res, 'Escreva algo para publicar.');
    if (text.length > 2000) return badRequest(res, 'Máximo de 2000 caracteres.');

    const data = { text };
    if (req.body.backgroundId !== undefined) {
      if (!req.body.backgroundId) {
        data.backgroundId = null;
      } else {
        const n = parseInt(req.body.backgroundId, 10);
        data.backgroundId = (n >= 1 && n <= 8) ? n : null;
      }
    }

    const updated = await prisma.communityPost.update({ where: { id: post.id }, data, include: postInclude });

    mentionSvc.syncMentions({
      text,
      authorId: req.user.id,
      authorName: req.user.name,
      communityPostId: post.id,
      link: `comunidade.html?id=${req.params.idOrSlug}`
    }).catch(() => {});

    return ok(res, { post: updated }, 'Publicação actualizada.');
  } catch (err) {
    logger.error(`[Groups.updatePost] ${err.message}`);
    return serverError(res);
  }
};

// ─── Apagar post: o autor, o dono/admin/moderador do grupo, ou um
// admin da plataforma (mesma regra de "canModerate" já usada no
// frontend: isOwnPost || ownerId===user.id — aqui alargada a
// ADMIN/MODERATOR também, sem contradizer o que o frontend já faz). ─
const removePost = async (req, res) => {
  try {
    const community = await resolveCommunity(req.params.idOrSlug);
    if (!community) return notFound(res, 'Comunidade não encontrada.');

    const post = await prisma.communityPost.findFirst({
      where: { id: req.params.postId, communityId: community.id },
      include: { images: true }
    });
    if (!post) return ok(res, {}, 'Publicação removida.');

    const canDelete = post.authorId === req.user.id ||
      (await communitySvc.isModOrAdmin(community, req.user.id)) ||
      req.user.role === 'ADMIN';
    if (!canDelete) return forbidden(res, 'Sem permissão para apagar esta publicação.');

    post.images.forEach((img) => { if (img.publicId) uploadSvc.deleteFromCloud(img.publicId).catch(() => {}); });
    try {
      await prisma.communityPost.delete({ where: { id: post.id } });
    } catch (delErr) {
      if (delErr.code !== 'P2025') throw delErr;
    }
    return ok(res, {}, 'Publicação removida.');
  } catch (err) {
    logger.error(`[Groups.removePost] ${err.message}`);
    return serverError(res);
  }
};

// ─── DONO/ADMIN/MODERADOR: fixar/desafixar um post no topo (bónus —
// sem indicação visual própria ainda no frontend actual). ──────────
const pinPost = async (req, res) => {
  try {
    const community = await resolveCommunity(req.params.idOrSlug);
    if (!community) return notFound(res, 'Comunidade não encontrada.');
    if (!(await communitySvc.isModOrAdmin(community, req.user.id))) return forbidden(res);

    const post = await prisma.communityPost.findFirst({ where: { id: req.params.postId, communityId: community.id } });
    if (!post) return notFound(res, 'Publicação não encontrada.');

    const updated = await prisma.communityPost.update({ where: { id: post.id }, data: { pinned: !post.pinned } });
    return ok(res, { pinned: updated.pinned }, updated.pinned ? 'Publicação fixada.' : 'Publicação desafixada.');
  } catch (err) {
    logger.error(`[Groups.pinPost] ${err.message}`);
    return serverError(res);
  }
};

module.exports = {
  list, getOne, create, update, remove,
  join, leave, listMembers, removeMember, updateMemberRole,
  listPosts, getPost, createPost, updatePost, removePost, pinPost
};
