'use strict';

const prisma = require('../config/database');

// ─── Devolve a linha de membro (ou null) de um utilizador num grupo ──
const getMembership = (communityId, userId) => {
  if (!userId) return Promise.resolve(null);
  return prisma.communityMember.findUnique({
    where: { communityId_userId: { communityId, userId } }
  });
};

const isMember = async (communityId, userId) => !!(await getMembership(communityId, userId));

// O dono (Community.ownerId) é sempre admin, mesmo que por alguma
// razão a sua linha em CommunityMember não tenha role=ADMIN (nunca
// deveria acontecer, mas não custa nada ser à prova disto) — role
// ADMIN/MODERATOR só existe para quem o dono promover.
const isModOrAdmin = async (community, userId) => {
  if (!userId) return false;
  if (community.ownerId === userId) return true;
  const m = await getMembership(community.id, userId);
  return !!(m && (m.role === 'ADMIN' || m.role === 'MODERATOR'));
};

const isAdmin = async (community, userId) => {
  if (!userId) return false;
  if (community.ownerId === userId) return true;
  const m = await getMembership(community.id, userId);
  return !!(m && m.role === 'ADMIN');
};

// ─── Junta memberCount/postCount + o estado do próprio utilizador
// (isMember/isOwner) a uma lista de grupos — mesma ideia do
// attachEngagement do feed, um único sítio para estes números nunca
// ficarem diferentes consoante a página. ──────────────────────────
const shapeCommunities = async (communities, userId) => {
  if (!communities.length) return communities;
  const ids = communities.map((c) => c.id);

  const [memberCounts, postCounts, myMemberships, myRequests] = await Promise.all([
    prisma.communityMember.groupBy({ by: ['communityId'], where: { communityId: { in: ids } }, _count: true }),
    prisma.communityPost.groupBy({ by: ['communityId'], where: { communityId: { in: ids } }, _count: true }),
    userId
      ? prisma.communityMember.findMany({ where: { communityId: { in: ids }, userId } })
      : [],
    userId
      ? prisma.communityJoinRequest.findMany({ where: { communityId: { in: ids }, userId, status: 'PENDING' }, select: { communityId: true } })
      : []
  ]);

  const memberCountMap = {};
  memberCounts.forEach((c) => { memberCountMap[c.communityId] = c._count; });
  const postCountMap = {};
  postCounts.forEach((c) => { postCountMap[c.communityId] = c._count; });
  const myMap = {};
  myMemberships.forEach((m) => { myMap[m.communityId] = m; });
  const myReqSet = new Set(myRequests.map((r) => r.communityId));

  // Papel do utilizador em cada grupo (o dono é sempre ADMIN) e, só para quem modera,
  // quantos pedidos de entrada estão pendentes.
  const roleOf = (c) => {
    if (!userId) return null;
    if (c.ownerId === userId) return 'ADMIN';
    return myMap[c.id]?.role || null;
  };
  const modIds = communities.filter((c) => ['ADMIN', 'MODERATOR'].includes(roleOf(c))).map((c) => c.id);
  const pendingMap = {};
  if (modIds.length) {
    const pend = await prisma.communityJoinRequest.groupBy({
      by: ['communityId'], where: { communityId: { in: modIds }, status: 'PENDING' }, _count: true
    });
    pend.forEach((x) => { pendingMap[x.communityId] = x._count; });
  }

  return communities.map((c) => {
    const myRole = roleOf(c);
    const out = {
      ...c,
      memberCount: memberCountMap[c.id] || 0,
      postCount: postCountMap[c.id] || 0,
      isMember: !!myMap[c.id],
      isOwner: !!(userId && c.ownerId === userId),
      joinApproval: !!c.joinApproval,
      rules: c.rules || null,
      myRole,
      myRequest: myReqSet.has(c.id) ? 'PENDING' : null
    };
    if (['ADMIN', 'MODERATOR'].includes(myRole)) out.pendingRequestCount = pendingMap[c.id] || 0;
    return out;
  });
};

const shapeCommunity = async (community, userId) => {
  const [shaped] = await shapeCommunities([community], userId);
  return shaped;
};

// Aceita boolean, 'true'/'false', '1'/'0' (multipart manda tudo como texto).
const parseBool = (v, fallback = false) => {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return ['true', '1', 'on', 'yes', 'sim'].includes(String(v).toLowerCase());
};

module.exports = { parseBool, getMembership, isMember, isModOrAdmin, isAdmin, shapeCommunities, shapeCommunity };
