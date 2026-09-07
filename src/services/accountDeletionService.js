'use strict';

// ─────────────────────────────────────────────────────────────────
// Antes desta correcção existiam DOIS caminhos de eliminação de conta
// com conjuntos de limpeza diferentes: userController.deleteAccount
// (self-delete) era bastante completo, adminController.deleteUser
// (admin) só tratava Order/Review/Transaction/RevendedorInvite. Uma
// conta podia ser eliminável por um método mas não pelo outro,
// consoante que relações tivesse. Esta função é agora a ÚNICA fonte
// de verdade — ambos os controllers chamam-na dentro da sua própria
// transacção.
//
// Muitas relações já têm onDelete: Cascade no schema (Bazar→Product→
// imagens/favoritos/carrinho, PremiumSubscription, SellerThumbVote,
// RefreshToken, etc.) — não é preciso duplicar essa limpeza aqui.
// O que TEM de ser tratado manualmente são as relações obrigatórias
// sem cascade (Order.buyer/seller, Review.seller/buyer,
// Transaction.seller) e os casos em que apagar tudo cegamente
// destruiria histórico da OUTRA parte (ex: apagar uma Order apaga
// também a experiência de compra do outro lado da transacção — por
// isso limitamo-nos às ordens em que o utilizador é uma das partes,
// nunca a ordens de terceiros).
// ─────────────────────────────────────────────────────────────────

async function deleteUserData(tx, userId) {
  const bazar = await tx.bazar.findUnique({ where: { sellerId: userId } });
  const productIds = bazar
    ? (await tx.product.findMany({ where: { bazarId: bazar.id }, select: { id: true } })).map(p => p.id)
    : [];
  const orderIds = (await tx.order.findMany({
    where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
    select: { id: true }
  })).map(o => o.id);

  const chats = await tx.chat.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }] },
    select: { id: true }
  });
  const chatIds = chats.map(c => c.id);
  if (chatIds.length) await tx.message.deleteMany({ where: { chatId: { in: chatIds } } });
  await tx.message.deleteMany({ where: { senderId: userId } });
  if (chatIds.length) await tx.chat.deleteMany({ where: { id: { in: chatIds } } });

  await tx.notification.deleteMany({ where: { userId } });
  await tx.favorite.deleteMany({ where: { userId } });
  await tx.cartItem.deleteMany({ where: { userId } });
  await tx.refreshToken.deleteMany({ where: { userId } });
  await tx.verificationCode.deleteMany({ where: { userId } });
  await tx.loginAttempt.updateMany({ where: { userId }, data: { userId: null } });
  await tx.report.deleteMany({ where: { OR: [{ reporterId: userId }, { targetUserId: userId }] } });

  // FeedReaction/FeedShare/Comment/CommentLike/SellerThumbVote não têm
  // relação directa com onDelete definido para o autor em todos os
  // casos — apagamos explicitamente pelo userId para não deixar
  // engagement órfão a apontar para uma conta que já não existe.
  await tx.feedReaction.deleteMany({ where: { userId } }).catch(() => {});
  await tx.feedShare.deleteMany({ where: { userId } }).catch(() => {});
  await tx.commentLike.deleteMany({ where: { userId } }).catch(() => {});
  await tx.comment.deleteMany({ where: { userId } }).catch(() => {});
  await tx.follow.deleteMany({ where: { userId } }).catch(() => {});

  if (orderIds.length) {
    await tx.review.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.transaction.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.order.deleteMany({ where: { id: { in: orderIds } } });
  }
  await tx.review.deleteMany({ where: { sellerId: userId } });

  if (productIds.length) {
    await tx.report.deleteMany({ where: { targetProductId: { in: productIds } } });
    await tx.review.deleteMany({ where: { productId: { in: productIds } } });
    await tx.favorite.deleteMany({ where: { productId: { in: productIds } } });
    await tx.cartItem.deleteMany({ where: { productId: { in: productIds } } });
    await tx.orderItem.deleteMany({ where: { productId: { in: productIds } } });
    await tx.productImage.deleteMany({ where: { productId: { in: productIds } } });
    await tx.product.deleteMany({ where: { id: { in: productIds } } });
  }
  if (bazar) {
    await tx.transaction.deleteMany({ where: { bazarId: bazar.id } });
    await tx.bazar.delete({ where: { id: bazar.id } });
  }

  // Convites de revendedor: só os NÃO usados são apagados — os já
  // usados ficam (createdById agora aceita NULL no schema, ver
  // RevendedorInvite.createdBy onDelete: SetNull) para preservar o
  // histórico de "quem convidou quem", sem bloquear a eliminação.
  await tx.revendedorInvite.deleteMany({ where: { createdById: userId, used: false } });
  await tx.user.updateMany({ where: { revendedorId: userId }, data: { revendedorId: null } });

  await tx.user.delete({ where: { id: userId } });
}

module.exports = { deleteUserData };
