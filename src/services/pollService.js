'use strict';

const prisma = require('../config/database');

// Formato devolvido ao frontend para uma sondagem — sempre com
// contagens e percentagens já calculadas (o cliente nunca faz essa
// conta), e `myOptionIds` para saber em que opção(ões) pintar o
// "já votaste aqui" sem teres de comparar nada no frontend.
async function shapePoll(poll, userId) {
  if (!poll) return null;
  const options = await prisma.pollOption.findMany({
    where: { pollId: poll.id },
    orderBy: { order: 'asc' },
    include: { _count: { select: { votes: true } } }
  });
  const totalVotes = options.reduce((sum, o) => sum + o._count.votes, 0);

  let myOptionIds = [];
  if (userId) {
    const mine = await prisma.pollVote.findMany({
      where: { pollId: poll.id, userId },
      select: { optionId: true }
    });
    myOptionIds = mine.map(v => v.optionId);
  }

  const isExpired = !!(poll.expiresAt && poll.expiresAt < new Date());

  return {
    id: poll.id,
    allowMultiple: poll.allowMultiple,
    expiresAt: poll.expiresAt,
    isExpired,
    totalVotes,
    myOptionIds,
    options: options.map(o => ({
      id: o.id,
      text: o.text,
      votes: o._count.votes,
      pct: totalVotes ? Math.round((o._count.votes / totalVotes) * 100) : 0
    }))
  };
}

// Usado pelo feed/announcement (que já vêm com `poll` incluído da
// query principal) para acrescentar options/contagens sem repetir
// a lógica em cada sítio que devolve um Post.
async function attachPollToAnnouncements(announcements, userId) {
  return Promise.all(announcements.map(async (a) => {
    if (!a.poll) return a;
    return { ...a, poll: await shapePoll(a.poll, userId) };
  }));
}

module.exports = { shapePoll, attachPollToAnnouncements };
