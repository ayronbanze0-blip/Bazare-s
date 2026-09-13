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

  const [memberCounts, postCounts, myMemberships] = await Promise.all([
    prisma.communityMember.groupBy({ by: ['communityId'], where: { communityId: { in: ids } }, _count: true }),
    prisma.communityPost.groupBy({ by: ['communityId'], where: { communityId: { in: ids } }, _count: true }),
    userId
      ? prisma.communityMember.findMany({ where: { communityId: { in: ids }, userId } })
      : []
  ]);

  const memberCountMap = {};
  memberCounts.forEach((c) => { memberCountMap[c.communityId] = c._count; });
  const postCountMap = {};
  postCounts.forEach((c) => { postCountMap[c.communityId] = c._count; });
  const myMap = {};
  myMemberships.forEach((m) => { myMap[m.communityId] = m; });

  return communities.map((c) => ({
    ...c,
    memberCount: memberCountMap[c.id] || 0,
    postCount: postCountMap[c.id] || 0,
    isMember: !!myMap[c.id],
    isOwner: !!(userId && c.ownerId === userId)
  }));
};

const shapeCommunity = async (community, userId) => {
  const [shaped] = await shapeCommunities([community], userId);
  return shaped;
};

module.exports = { getMembership, isMember, isModOrAdmin, isAdmin, shapeCommunities, shapeCommunity };
