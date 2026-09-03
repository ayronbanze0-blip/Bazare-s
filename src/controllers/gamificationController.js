'use strict';

const { ok, serverError } = require('../utils/response');
const logger = require('../utils/logger');
const prisma = require('../config/database');

// ─────────────────────────────────────────────────────────────────
// GAMIFICAÇÃO — Nível + desafios do utilizador
//
// O frontend (home.html → loadGamification) já chamava GET /gamification/me
// desde sempre, mas este endpoint nunca existiu no backend — daí a rota
// aparecer no topo do painel de erros (FALHA, a mais frequente de todas:
// dispara em toda visita à home). Em vez de criar tabelas novas só para
// "pontos"/"nível" (schema/migração extra, dados que teriam de ser
// mantidos sincronizados à parte), calculamos tudo aqui a partir de
// dados que já existem e já são a fonte de verdade (vendas, avaliações,
// seguidores, perfil) — nunca fica dessincronizado, e funciona já para
// todas as contas existentes sem precisar de backfill.
//
// Pontuação: soma de POINTS de cada desafio concluído. Nível: cada 100
// pontos = 1 nível (fórmula simples e previsível — fácil de ajustar só
// mudando POINTS_PER_LEVEL, sem tocar no resto).
// ─────────────────────────────────────────────────────────────────

const POINTS_PER_LEVEL = 100;

// Desafios comuns a qualquer conta (compradora ou vendedora).
const buildCommonChallenges = (user, reviewsGivenCount) => ([
  {
    id: 'profile_complete',
    label: 'Completa o teu perfil',
    points: 20,
    completed: Boolean(user.avatarUrl && user.bio && user.location)
  },
  {
    id: 'first_review',
    label: 'Escreve a tua primeira avaliação',
    points: 15,
    completed: reviewsGivenCount >= 1
  }
]);

// Desafios só para quem tem loja (vendedor) — escondidos para
// compradores puros, para a lista nunca mostrar metas impossíveis.
const buildSellerChallenges = ({ hasBazar, productCount, deliveredSalesCount, verifiedSeller, followerCount }) => ([
  {
    id: 'bazar_created',
    label: 'Cria a tua loja',
    points: 20,
    completed: hasBazar
  },
  {
    id: 'first_product',
    label: 'Publica o teu primeiro produto',
    points: 30,
    completed: productCount >= 1
  },
  {
    id: 'first_sale',
    label: 'Faz a tua primeira venda',
    points: 50,
    completed: deliveredSalesCount >= 1
  },
  {
    id: 'five_sales',
    label: 'Conclui 5 vendas',
    points: 100,
    completed: deliveredSalesCount >= 5
  },
  {
    id: 'ten_followers',
    label: 'Consegue 10 seguidores na loja',
    points: 40,
    completed: followerCount >= 10
  },
  {
    id: 'verified_seller',
    label: 'Torna-te vendedor verificado',
    points: 80,
    completed: verifiedSeller
  }
]);

// Desafios só para compradores sem loja — dão-lhes o que fazer mesmo
// sem terem entrado no lado de venda ainda.
const buildBuyerChallenges = ({ deliveredPurchasesCount }) => ([
  {
    id: 'first_purchase',
    label: 'Faz a tua primeira compra',
    points: 20,
    completed: deliveredPurchasesCount >= 1
  }
]);

const me = async (req, res) => {
  try {
    const userId = req.user.id;

    const [user, reviewsGivenCount, bazar, deliveredPurchasesCount] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { avatarUrl: true, bio: true, location: true, verifiedSeller: true }
      }),
      prisma.review.count({ where: { buyerId: userId } }),
      prisma.bazar.findUnique({
        where: { sellerId: userId },
        select: {
          id: true,
          _count: { select: { products: true, followers: true } }
        }
      }),
      prisma.order.count({ where: { buyerId: userId, status: 'ENTREGUE' } })
    ]);

    if (!user) return serverError(res);

    let challenges = buildCommonChallenges(user, reviewsGivenCount);

    if (bazar) {
      const deliveredSalesCount = await prisma.order.count({
        where: { sellerId: userId, status: 'ENTREGUE' }
      });
      challenges = challenges.concat(buildSellerChallenges({
        hasBazar: true,
        productCount: bazar._count.products,
        deliveredSalesCount,
        verifiedSeller: user.verifiedSeller,
        followerCount: bazar._count.followers
      }));
    } else {
      challenges = challenges.concat(buildBuyerChallenges({ deliveredPurchasesCount }));
    }

    const totalPoints = challenges.reduce((sum, c) => sum + (c.completed ? c.points : 0), 0);
    const level = Math.floor(totalPoints / POINTS_PER_LEVEL) + 1;
    const pointsIntoLevel = totalPoints % POINTS_PER_LEVEL;

    // Mostra primeiro os por concluir (é isso que dá vontade de agir),
    // depois os já feitos.
    challenges.sort((a, b) => Number(a.completed) - Number(b.completed));

    return ok(res, {
      level,
      totalPoints,
      pointsIntoLevel,
      pointsForNextLevel: POINTS_PER_LEVEL,
      challenges
    });
  } catch (err) {
    logger.error(`[Gamification.me] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { me };
