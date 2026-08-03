'use strict';

const { ok, created, notFound, forbidden, serverError, badRequest } = require('../utils/response');
const { sanitize } = require('../utils/helpers');
const uploadSvc = require('../services/uploadService');
const notifSvc = require('../services/notificationService');
const logger = require('../utils/logger');
const prisma = require('../config/database');

const STORY_TTL_MS = 24 * 60 * 60 * 1000;

const resolveBazar = (idOrSlug) =>
  prisma.bazar.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] } });

// ─── GET /api/stories — histórias activas, agrupadas por bazar ───
// Usado na barra de histórias da Home. Devolve só bazares com pelo
// menos uma história ainda dentro das 24h, mais recentes primeiro,
// com `hasUnseen` para desenhar o anel a verde (por ver) ou cinza
// (já vistas por este utilizador).
const list = async (req, res) => {
  try {
    const stories = await prisma.story.findMany({
      where: { expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      include: {
        bazar: { select: { id: true, name: true, slug: true, logoUrl: true } },
        seller: { select: { id: true, name: true, isPremium: true } },
        ...(req.user && { views: { where: { userId: req.user.id }, select: { id: true } } })
      }
    });

    const byBazar = new Map();
    for (const s of stories) {
      const key = s.bazarId;
      if (!byBazar.has(key)) byBazar.set(key, { bazar: s.bazar, seller: s.seller, stories: [], hasUnseen: false });
      const group = byBazar.get(key);
      const seen = req.user ? (s.views?.length > 0) : false;
      group.stories.push({ id: s.id, imageUrl: s.imageUrl, videoUrl: s.videoUrl, text: s.text, createdAt: s.createdAt, expiresAt: s.expiresAt, seen });
      if (!seen) group.hasUnseen = true;
    }
    // Bazares com história por ver aparecem primeiro (como no Instagram).
    const groups = [...byBazar.values()].sort((a, b) => (b.hasUnseen - a.hasUnseen));

    return ok(res, { groups });
  } catch (err) {
    logger.error(`[Stories.list] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Publicar uma história ────────────────────────────────
const create = async (req, res) => {
  try {
    const bazar = await resolveBazar(req.params.idOrSlug);
    if (!bazar) return notFound(res, 'Bazar não encontrado.');
    if (bazar.sellerId !== req.user.id) return forbidden(res);

    // Uma história é imagem OU vídeo — nunca ambos. O vídeo já vem
    // editado e processado pelo editor de vídeo (Fase 3): em vez de
    // reenviar o ficheiro, o frontend refere o `processedVideoJobId`
    // devolvido por POST /api/media/video/process depois de
    // status=DONE. Fotos continuam a chegar por multipart normal
    // ('image').
    const jobId = req.body.processedVideoJobId;
    const imageFile = req.files?.image?.[0];
    if (!imageFile && !jobId) return badRequest(res, 'A história precisa de uma foto ou de um vídeo (editado).');

    let imageUrl = null, imagePublicId = null, videoUrl = null, videoPublicId = null;
    let thumbnailUrl = null, thumbnailPublicId = null, videoDurationSec = null;

    if (imageFile) {
      const up = await uploadSvc.uploadToCloud(imageFile.path, 'bazares/stories');
      if (!up.ok) return badRequest(res, 'Falha ao enviar a imagem.');
      imageUrl = up.url; imagePublicId = up.publicId;
    } else {
      const job = await prisma.videoJob.findUnique({ where: { id: jobId } });
      if (!job || job.userId !== req.user.id) return badRequest(res, 'Vídeo processado não encontrado.');
      if (job.status !== 'DONE') return badRequest(res, 'O vídeo ainda está a ser processado. Aguarda a conclusão antes de publicar.');
      videoUrl = job.resultUrl; videoPublicId = job.resultPublicId;
      thumbnailUrl = job.thumbnailUrl; thumbnailPublicId = job.thumbnailPublicId;
      videoDurationSec = job.durationSec;
    }

    const text = (req.body.text || '').trim().slice(0, 200) || null;
    const now = new Date();
    const story = await prisma.story.create({
      data: {
        bazarId: bazar.id,
        sellerId: req.user.id,
        imageUrl, imagePublicId, videoUrl, videoPublicId,
        thumbnailUrl, thumbnailPublicId, videoDurationSec,
        text,
        createdAt: now,
        expiresAt: new Date(now.getTime() + STORY_TTL_MS)
      }
    });

    return created(res, { story }, 'História publicada — fica visível durante 24h.');
  } catch (err) {
    logger.error(`[Stories.create] ${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/stories/:id/view — marca como vista pelo utilizador ─
const markViewed = async (req, res) => {
  try {
    await prisma.storyView.upsert({
      where: { storyId_userId: { storyId: req.params.id, userId: req.user.id } },
      update: {},
      create: { storyId: req.params.id, userId: req.user.id }
    });
    return ok(res, { viewed: true });
  } catch (err) {
    // Não é crítico — se falhar, a pior consequência é a história
    // continuar a aparecer como "por ver". Nunca deve rebentar a UI.
    logger.error(`[Stories.markViewed] ${err.message}`);
    return ok(res, { viewed: false });
  }
};

// ─── POST /api/stories/:storyId/reply — responder a uma história ──
// Ao estilo Instagram: a resposta não cria um sistema de comentários
// novo — vira uma mensagem normal no chat com o vendedor, com a foto
// da história em anexo para dar contexto de que se está a responder.
const reply = async (req, res) => {
  try {
    const story = await prisma.story.findUnique({ where: { id: req.params.storyId } });
    if (!story) return notFound(res, 'História não encontrada.');
    if (story.expiresAt < new Date()) return badRequest(res, 'Esta história já expirou.');
    if (story.sellerId === req.user.id) return badRequest(res, 'Não pode responder à sua própria história.');

    const text = sanitize(req.body.text || '');
    if (!text) return badRequest(res, 'Escreva uma resposta.');
    if (text.length > 500) return badRequest(res, 'Máximo de 500 caracteres.');

    const [userAId, userBId] = [req.user.id, story.sellerId].sort();
    let chat = await prisma.chat.findUnique({ where: { userAId_userBId: { userAId, userBId } } });
    if (!chat) {
      try {
        chat = await prisma.chat.create({ data: { userAId, userBId } });
      } catch (createErr) {
        if (createErr.code !== 'P2002') throw createErr;
        chat = await prisma.chat.findUnique({ where: { userAId_userBId: { userAId, userBId } } });
      }
    }

    const message = await prisma.message.create({
      data: {
        chatId: chat.id,
        senderId: req.user.id,
        text: `Respondeu à sua história: "${text}"`,
        imageUrl: story.imageUrl
      },
      include: { sender: { select: { id: true, name: true, avatarUrl: true } } }
    });

    await prisma.chat.update({ where: { id: chat.id }, data: { updatedAt: new Date() } });

    const io = req.app.get('io');
    if (io) {
      io.to(`chat:${chat.id}`).emit('message:new', message);
      io.to(`user:${story.sellerId}`).emit('chat:unread', { chatId: chat.id });
    }
    notifSvc.newMessage(story.sellerId, req.user.name, `respondeu à sua história`);

    return created(res, { chatId: chat.id, message }, 'Resposta enviada.');
  } catch (err) {
    logger.error(`[Stories.reply] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET /api/stories/:storyId/viewers — quem viu (só o dono vê) ──
// Tal como no Instagram: o vendedor consegue ver a lista de quem viu
// cada história sua, e o total.
const viewers = async (req, res) => {
  try {
    const story = await prisma.story.findUnique({ where: { id: req.params.storyId } });
    if (!story) return notFound(res, 'História não encontrada.');
    if (story.sellerId !== req.user.id) return forbidden(res);

    const views = await prisma.storyView.findMany({
      where: { storyId: story.id },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: 'desc' }
    });

    return ok(res, { count: views.length, views });
  } catch (err) {
    logger.error(`[Stories.viewers] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Editar a legenda de uma história (antes de expirar) ──
const updateText = async (req, res) => {
  try {
    const story = await prisma.story.findUnique({ where: { id: req.params.storyId } });
    if (!story) return notFound(res, 'História não encontrada.');
    if (story.sellerId !== req.user.id) return forbidden(res);
    if (story.expiresAt < new Date()) return badRequest(res, 'Esta história já expirou.');

    const text = (req.body.text || '').trim().slice(0, 200) || null;
    const updated = await prisma.story.update({ where: { id: story.id }, data: { text } });
    return ok(res, { story: updated }, 'História actualizada.');
  } catch (err) {
    logger.error(`[Stories.updateText] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER/ADMIN: Apagar uma história antes das 24h ──────────────
const remove = async (req, res) => {
  try {
    const story = await prisma.story.findUnique({ where: { id: req.params.storyId } });
    if (!story) return notFound(res, 'História não encontrada.');
    if (story.sellerId !== req.user.id && req.user.role !== 'ADMIN') return forbidden(res);

    if (story.imagePublicId) uploadSvc.deleteFromCloud(story.imagePublicId).catch(() => {});
    if (story.videoPublicId) uploadSvc.deleteFromCloud(story.videoPublicId).catch(() => {});
    if (story.thumbnailPublicId) uploadSvc.deleteFromCloud(story.thumbnailPublicId).catch(() => {});
    await prisma.story.delete({ where: { id: story.id } });
    return ok(res, {}, 'História removida.');
  } catch (err) {
    logger.error(`[Stories.remove] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { list, create, markViewed, updateText, remove, reply, viewers };
